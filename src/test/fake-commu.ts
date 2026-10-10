// 테스트용 가짜 Commu API (API_CONTRACT 2.1~2.7 + SSE 3장의 부분 집합). 상태는 메모리.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  Appearance,
  ChunkCoord,
  DmMessage,
  Group,
  GroupMemberWithUser,
  GroupMessage,
  Me,
  Position,
  Presence,
  PublicMessage,
  ServerConfig,
  User,
  WorldChunk,
} from '../commu/schemas.js';

export const TEST_AI_TOKEN = 'dvai_test_0001';
export const SPAWN = { x: 20, y: 15 };

export const defaultAppearance: Appearance = {
  skin: 'skin_01',
  hairColor: 'hair_01',
  hair: null,
  hat: null,
  face: null,
  top: { itemId: 'top_tee' },
  bottom: { itemId: 'bottom_jeans' },
  shoes: { itemId: 'shoes_sneakers' },
  hand: null,
};

export const defaultConfig: ServerConfig = {
  proximityRadius: 5,
  positionBatchMs: 200,
  serverTickMs: 200,
  maxMessageLength: 200,
  defaultMapId: 'main',
  maxGroupMembers: 10,
  avatarOptions: {
    itemIds: [
      'top_tee',
      'top_hoodie',
      'bottom_jeans',
      'shoes_sneakers',
      'hat_beanie',
      'hair_short',
    ],
    skinRampIds: ['skin_01'],
    hairRampIds: ['hair_01'],
    itemRampIds: ['ramp_01'],
  },
  // DOMAIN 2.7 — 계약 스키마 사본이 아직 모르는 필드는 zod 가 버린다
  maxAiPerMember: 2,
  maxTokensPerAi: 2,
} as ServerConfig;

export interface FakeUser {
  id: string;
  nickname: string;
  online: boolean;
  position?: { x: number; y: number };
  status?: User['status'];
  /** 기본 human. ai 면 ownerId 도 준다 */
  kind?: User['kind'];
  ownerId?: string;
  statusMessage?: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface FakeGroup {
  group: Group;
  members: GroupMemberWithUser[];
  messages: GroupMessage[];
}

function extractLinks(content: string): string[] {
  return (content.match(/https?:\/\/\S+/g) ?? []).slice(0, 5);
}

/** 지상 월드로 띄울 때 (W6): 청크 사본과 처음 준비된 청크 (생략하면 전부) */
export interface FakeGround {
  chunks: WorldChunk[];
  ready?: ChunkCoord[];
  /** 입장 위치 (지난번 위치 흉내). 생략하면 home */
  spawn?: { x: number; y: number };
  /** 마을 귀환 위치 (원점 스폰). 생략하면 GROUND_HOME */
  home?: { x: number; y: number };
}

export const GROUND_CHUNK_SIZE = 32;
/** 지상 월드 원점 스폰 = 첫 마을 분수 광장 (프론트 Mock GROUND_SPAWN) */
export const GROUND_HOME = { x: 16, y: 20 };
/** API_CONTRACT 1.4: 마을 귀환 1회/10초 */
export const HOME_INTERVAL_MS = 10_000;

export class FakeCommu {
  readonly calls: RecordedCall[] = [];
  readonly me: Me;
  readonly config: ServerConfig;
  readonly others = new Map<string, FakeUser>();
  readonly blockedTiles = new Set<string>();
  /** 'main'(옛 맵) 또는 'world'(지상 월드) */
  readonly mapId: string;
  /** 마을 귀환 위치: 지상 월드는 원점 스폰, 옛 맵은 스폰 */
  readonly home: { x: number; y: number };
  myPosition: Position;
  /** 마지막 마을 귀환 시각 (10초 한도) */
  lastHomeAt: number | null = null;
  accessToken = 'access-1';
  origin = '';
  baseUrl = '';
  /** POST /auth/ai-token 호출 수 */
  exchangeCount = 0;
  revoked = false;
  suspended = false;

  private readonly expiredTokens = new Set<string>();
  private rateLimitOnce: number | null = null;
  private presenceMissingOnce = false;
  private positionRejects: {
    reason: 'not_ready' | 'collision' | 'too_far' | 'occupied';
    left: number;
  } | null = null;
  /** 지상 월드: 청크 사본(키 "cx,cy")과 준비된 청크 */
  private readonly groundChunks = new Map<string, WorldChunk>();
  private readonly readyChunks = new Set<string>();
  private readonly ground: boolean;
  private readonly tickets = new Set<string>();
  private readonly streams = new Set<http.ServerResponse>();
  /** 재전송 버퍼 (API_CONTRACT 3.1: lastEventId 이후를 snapshot 뒤에 다시 보낸다) */
  private readonly replay: Array<{ id: number; type: string; data: string }> = [];
  private counter = 1;
  private eventSeq = 1000;
  private readonly dms: DmMessage[] = [];
  private readonly groups = new Map<string, FakeGroup>();
  private readonly server: http.Server;

  constructor(
    opts: {
      me?: Partial<Me>;
      config?: Partial<ServerConfig>;
      others?: FakeUser[];
      ground?: FakeGround;
    } = {},
  ) {
    this.me = {
      id: 'u1',
      nickname: '에이전트',
      appearance: defaultAppearance,
      kind: 'ai',
      ownerId: 'owner-1',
      role: 'member',
      status: 'active',
      createdAt: 1_700_000_000_000,
      ...opts.me,
    };
    this.ground = opts.ground !== undefined;
    this.mapId = this.ground ? 'world' : 'main';
    this.config = {
      ...defaultConfig,
      ...(this.ground
        ? { defaultMapId: 'world', chunkSize: GROUND_CHUNK_SIZE, viewRadiusChunks: 2 }
        : {}),
      ...opts.config,
    };
    this.home = this.ground ? (opts.ground?.home ?? GROUND_HOME) : SPAWN;
    this.myPosition = { mapId: this.mapId, ...(opts.ground?.spawn ?? this.home), dir: 'down' };
    for (const chunk of opts.ground?.chunks ?? []) {
      this.groundChunks.set(`${String(chunk.cx)},${String(chunk.cy)}`, chunk);
    }
    for (const c of opts.ground?.ready ?? opts.ground?.chunks ?? []) {
      this.readyChunks.add(`${String(c.cx)},${String(c.cy)}`);
    }
    for (const other of opts.others ?? []) this.others.set(other.id, other);
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    this.baseUrl = `${this.origin}/api/v1`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get streamCount(): number {
    return this.streams.size;
  }

  /** 다음 요청부터 현재 접근 토큰을 401 AUTH_REQUIRED 로 거부한다 (재교환 경로 테스트) */
  expireAccessToken(): void {
    this.expiredTokens.add(this.accessToken);
  }

  /** API_CONTRACT 2.9: 토큰 폐기는 즉시 — 접근 토큰 401, 열린 SSE 종료 */
  revokeToken(): void {
    this.revoked = true;
    this.expiredTokens.add(this.accessToken);
    this.dropStreams();
  }

  /** 운영자 정지: system.suspended 뒤 연결 종료, 이후 교환은 403 */
  suspend(): void {
    this.suspended = true;
    this.emit('system.suspended', {});
    this.expiredTokens.add(this.accessToken);
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  /** 다음 메시지 전송(공개·DM·그룹) 1건을 429 로 거부한다 */
  rateLimitNextMessage(retryAfterSec = 3): void {
    this.rateLimitOnce = retryAfterSec;
  }

  /**
   * 다음 근접 대화 1건을 `404 presence` 로 거부한다 — SSE 가 조용히 끊겨 서버 유예가 지난 상황 (MCP.md 7: 다시 입장해 재시도).
   * 클라이언트는 아직 연결돼 있다고 믿는다
   */
  losePresenceOnce(): void {
    this.presenceMissingOnce = true;
  }

  /**
   * 다음 count 번의 PUT /me/position 을 reason 으로 409 거부한다 (details.position 은 현재 인정 위치).
   * 월드가 아직 모르는 끼어든 사람(occupied)·서버만 아는 벽(collision)·오래된 위치(too_far) 흉내
   */
  rejectPositions(reason: 'not_ready' | 'collision' | 'too_far' | 'occupied', count = 1): void {
    this.positionRejects = { reason, left: count };
  }

  /** 지상 월드: 사본의 청크를 준비됨으로 바꾸고 world.chunk 를 보낸다 (생성 흉내) */
  revealChunk(cx: number, cy: number): void {
    const key = `${String(cx)},${String(cy)}`;
    const chunk = this.groundChunks.get(key);
    if (!chunk) throw new Error(`no chunk ${key}`);
    this.readyChunks.add(key);
    this.emit('world.chunk', { mapId: this.mapId, chunk });
  }

  /** system.heartbeat (전체 접속자 수) */
  heartbeat(onlineCount = this.presences().length): void {
    this.emit('system.heartbeat', { serverTime: Date.now(), onlineCount });
  }

  /** 지상 월드: 그 칸이 준비된 청크의 walk 칸인지 ('.' 만 walk — 계약 자산과 같은 문자) */
  private groundTile(x: number, y: number): 'walk' | 'blocked' | 'not_ready' {
    const cx = Math.floor(x / GROUND_CHUNK_SIZE);
    const cy = Math.floor(y / GROUND_CHUNK_SIZE);
    const key = `${String(cx)},${String(cy)}`;
    const chunk = this.groundChunks.get(key);
    if (!chunk || !this.readyChunks.has(key)) return 'not_ready';
    const c = chunk.rows[y - cy * GROUND_CHUNK_SIZE]?.[x - cx * GROUND_CHUNK_SIZE];
    return c === '.' || c === ',' || c === ':' || c === '=' ? 'walk' : 'blocked';
  }

  /** 모든 열린 SSE 스트림에 이벤트를 쓴다 */
  emit(type: string, payload: unknown): string {
    const id = String(++this.eventSeq);
    const data = JSON.stringify({ id, type, ts: Date.now(), payload });
    this.replay.push({ id: Number(id), type, data });
    if (this.replay.length > 200) this.replay.shift();
    for (const stream of this.streams) {
      stream.write(`id: ${id}\nevent: ${type}\ndata: ${data}\n\n`);
    }
    return id;
  }

  /** 상대가 나에게 DM 을 보낸다: 히스토리에 넣고 chat.dm 을 보낸다 */
  receiveDm(peerId: string, content: string): DmMessage {
    const peer = this.others.get(peerId);
    if (!peer) throw new Error(`unknown peer ${peerId}`);
    const message: DmMessage = {
      kind: 'dm',
      id: this.nextId(),
      conversationId: `c_${peerId}`,
      senderId: peerId,
      content,
      links: extractLinks(content),
      createdAt: Date.now(),
    };
    this.dms.push(message);
    this.emit('chat.dm', { ...message, sender: this.userOf(peer), peerId });
    return message;
  }

  /** 다른 멤버가 그룹에 말한다: 히스토리에 넣고 chat.group 을 보낸다 */
  receiveGroupMessage(groupId: string, senderId: string, content: string): GroupMessage {
    const entry = this.groups.get(groupId);
    const sender = this.others.get(senderId);
    if (!entry || !sender) throw new Error(`unknown group ${groupId} or sender ${senderId}`);
    const message: GroupMessage = {
      kind: 'group',
      id: this.nextId(),
      groupId,
      senderId,
      content,
      links: extractLinks(content),
      createdAt: Date.now(),
    };
    entry.messages.push(message);
    this.emit('chat.group', { ...message, sender: this.userOf(sender) });
    return message;
  }

  /** 서버가 모든 스트림을 끊는다 (재연결 테스트) */
  dropStreams(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  userOf(fake: FakeUser): User {
    return {
      id: fake.id,
      nickname: fake.nickname,
      appearance: defaultAppearance,
      kind: fake.kind ?? 'human',
      ...(fake.ownerId !== undefined ? { ownerId: fake.ownerId } : {}),
      ...(fake.statusMessage !== undefined ? { statusMessage: fake.statusMessage } : {}),
      role: 'member',
      status: fake.status ?? 'active',
      createdAt: 1_700_000_000_000,
    };
  }

  presenceOf(fake: FakeUser): Presence {
    return {
      userId: fake.id,
      nickname: fake.nickname,
      appearance: defaultAppearance,
      kind: fake.kind ?? 'human',
      position: { mapId: this.mapId, ...(fake.position ?? SPAWN), dir: 'down' },
      state: 'online',
      updatedAt: Date.now(),
    };
  }

  private myPresence(): Presence {
    return {
      userId: this.me.id,
      nickname: this.me.nickname,
      appearance: this.me.appearance,
      kind: 'ai',
      position: this.myPosition,
      state: 'online',
      updatedAt: Date.now(),
    };
  }

  private presences(): Presence[] {
    const list = [...this.others.values()].filter((u) => u.online).map((u) => this.presenceOf(u));
    return this.streams.size > 0 ? [this.myPresence(), ...list] : list;
  }

  private nextId(): string {
    return String(++this.counter);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = req.method ?? 'GET';
    const body = await readJson(req);
    this.calls.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });

    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(payload));
    };
    const noContent = (headers: Record<string, string> = {}) => {
      res.writeHead(204, headers);
      res.end();
    };
    const fail = (status: number, code: string, message: string, details?: unknown) =>
      json(status, { code, message, ...(details ? { details } : {}) });
    const rateLimited = () => {
      if (this.rateLimitOnce === null) return false;
      const sec = this.rateLimitOnce;
      this.rateLimitOnce = null;
      json(
        429,
        { code: 'RATE_LIMITED', message: '너무 자주 보냈어요' },
        { 'Retry-After': String(sec) },
      );
      return true;
    };

    // ---------- 인증 없는 경로 ----------
    if (method === 'POST' && path === '/auth/ai-token') {
      this.exchangeCount++;
      if (this.suspended) return fail(403, 'USER_SUSPENDED', '정지된 AI');
      const token = (body as { token?: string } | null)?.token;
      if (token !== TEST_AI_TOKEN || this.revoked) {
        return fail(401, 'AUTH_INVALID_KEY', '토큰이 없거나 폐기됐어요');
      }
      this.accessToken = `access-${++this.counter}`;
      return json(200, {
        accessToken: this.accessToken,
        expiresIn: 900,
        me: this.me,
        config: this.config,
      });
    }
    if (method === 'GET' && path === '/sse') {
      const ticket = url.searchParams.get('ticket') ?? '';
      if (!this.tickets.delete(ticket)) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      const lastEventId = url.searchParams.get('lastEventId');
      const presences = this.presences();
      this.emitTo(
        res,
        'world.snapshot',
        { mapId: this.mapId, presences, onlineCount: presences.length, serverTime: Date.now() },
        lastEventId ?? undefined,
      );
      if (lastEventId !== null) {
        for (const e of this.replay) {
          if (e.id > Number(lastEventId))
            res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${e.data}\n\n`);
        }
      }
      return;
    }

    // ---------- Bearer 인증 ----------
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || token !== this.accessToken || this.expiredTokens.has(token)) {
      return fail(401, 'AUTH_REQUIRED', '인증이 필요해요');
    }

    if (method === 'POST' && path === '/sse/ticket') {
      const ticket = `t_${this.nextId()}`;
      this.tickets.add(ticket);
      return json(201, { ticket, expiresIn: 30 });
    }
    if (method === 'GET' && path === '/me') return json(200, { me: this.me, config: this.config });
    if (method === 'PATCH' && path === '/me') {
      const b = (body ?? {}) as {
        nickname?: string;
        statusMessage?: string;
        appearance?: Me['appearance'];
      };
      if (b.nickname !== undefined) {
        const nickname = b.nickname.trim();
        const len = [...nickname].length;
        if (len < 2 || len > 12) {
          return fail(400, 'VALIDATION_FAILED', '닉네임 길이', { fields: { nickname: 'length' } });
        }
        // API_CONTRACT 2.2·2.8: 400 → NICKNAME_COOLDOWN → NICKNAME_TAKEN
        const changeableAt = this.me.nicknameChangeableAt;
        if (changeableAt !== undefined && changeableAt > Date.now()) {
          return fail(409, 'NICKNAME_COOLDOWN', '닉네임 변경 대기', { nextChangeAt: changeableAt });
        }
        const lower = nickname.toLowerCase();
        if ([...this.others.values()].some((u) => u.nickname.toLowerCase() === lower)) {
          return fail(409, 'NICKNAME_TAKEN', '이미 있는 닉네임');
        }
        if (nickname !== this.me.nickname) {
          this.me.nickname = nickname;
          this.me.nicknameChangeableAt = Date.now() + 24 * 60 * 60 * 1000;
        }
      }
      if (b.appearance !== undefined) this.me.appearance = b.appearance;
      if (b.statusMessage !== undefined) {
        if (b.statusMessage === '') delete this.me.statusMessage;
        else this.me.statusMessage = b.statusMessage;
      }
      return json(200, this.me);
    }
    if (method === 'PUT' && path === '/me/position') {
      const b = body as Position & { seq: number };
      if (this.streams.size === 0)
        return fail(404, 'NOT_FOUND', 'Presence 없음', { resource: 'presence' });
      if (b.mapId !== this.mapId)
        return fail(400, 'VALIDATION_FAILED', '맵', { fields: { mapId: 'invalid' } });
      const reject = (reason: string) =>
        fail(409, 'POSITION_REJECTED', `이동 거부: ${reason}`, {
          position: this.myPosition,
          seq: b.seq - 1,
          reason,
        });
      if (this.positionRejects && this.positionRejects.left > 0) {
        this.positionRejects.left -= 1;
        return reject(this.positionRejects.reason);
      }
      if (this.ground) {
        const tile = this.groundTile(b.x, b.y);
        if (tile === 'not_ready') return reject('not_ready');
        if (tile === 'blocked' || this.blockedTiles.has(`${b.x},${b.y}`))
          return reject('collision');
      } else if (
        this.blockedTiles.has(`${b.x},${b.y}`) ||
        b.x < 0 ||
        b.y < 0 ||
        b.x >= 40 ||
        b.y >= 30
      ) {
        return reject('collision');
      }
      if (Math.max(Math.abs(b.x - this.myPosition.x), Math.abs(b.y - this.myPosition.y)) > 3) {
        return reject('too_far');
      }
      for (const other of this.others.values()) {
        if (other.online && other.position?.x === b.x && other.position.y === b.y)
          return reject('occupied');
      }
      this.myPosition = { mapId: this.mapId, x: b.x, y: b.y, dir: b.dir };
      return noContent();
    }
    if (method === 'POST' && path === '/me/position/home') {
      if (this.streams.size === 0)
        return fail(404, 'NOT_FOUND', 'Presence 없음', { resource: 'presence' });
      const now = Date.now();
      if (this.lastHomeAt !== null && now - this.lastHomeAt < HOME_INTERVAL_MS) {
        const sec = Math.ceil((HOME_INTERVAL_MS - (now - this.lastHomeAt)) / 1000);
        return json(
          429,
          { code: 'RATE_LIMITED', message: '너무 자주 보냈어요' },
          { 'Retry-After': String(sec) },
        );
      }
      this.lastHomeAt = now;
      this.myPosition = { mapId: this.mapId, ...this.home, dir: 'down' };
      // API_CONTRACT 2.2: 내 모든 연결에 새 world.snapshot (재전송 버퍼에는 넣지 않는다)
      const presences = this.presences();
      for (const stream of this.streams) {
        this.emitTo(stream, 'world.snapshot', {
          mapId: this.mapId,
          presences,
          onlineCount: presences.length,
          serverTime: now,
        });
      }
      return json(200, this.myPosition);
    }
    if (method === 'PUT' && path === '/me/presence') return noContent();

    if (method === 'GET' && path === '/users') {
      const q = (url.searchParams.get('nickname') ?? '').toLowerCase();
      const items = [...this.others.values()]
        .filter((u) => u.nickname.toLowerCase().includes(q))
        .slice(0, 20)
        .map((u) => this.profileOf(u));
      return json(200, { items });
    }
    let m = /^\/users\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const user = this.others.get(decodeURIComponent(m[1]!));
      if (!user) return fail(404, 'NOT_FOUND', '사용자 없음', { resource: 'user' });
      return json(200, this.profileOf(user));
    }

    m = /^\/world\/([^/]+)\/presences$/.exec(path);
    if (method === 'GET' && m) {
      if (m[1] !== this.mapId) return fail(404, 'NOT_FOUND', '맵 없음', { resource: 'map' });
      const presences = this.presences();
      return json(200, {
        mapId: this.mapId,
        presences,
        onlineCount: presences.length,
        serverTime: Date.now(),
      });
    }

    m = /^\/world\/([^/]+)\/chunks$/.exec(path);
    if (method === 'GET' && m) {
      if (!this.ground || m[1] !== this.mapId)
        return fail(404, 'NOT_FOUND', '맵 없음', { resource: 'map' });
      const cx = Number(url.searchParams.get('cx'));
      const cy = Number(url.searchParams.get('cy'));
      const r = Number(url.searchParams.get('r') ?? '0');
      const chunks: WorldChunk[] = [];
      const pending: ChunkCoord[] = [];
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          const key = `${String(x)},${String(y)}`;
          const chunk = this.groundChunks.get(key);
          if (chunk && this.readyChunks.has(key)) chunks.push(chunk);
          else pending.push({ cx: x, cy: y });
        }
      }
      return json(200, { mapId: this.mapId, chunks, pending });
    }

    if (method === 'POST' && path === '/chat/public') {
      if (rateLimited()) return;
      const content = (body as { content?: string } | null)?.content ?? '';
      if (this.streams.size === 0 || this.presenceMissingOnce) {
        this.presenceMissingOnce = false;
        return fail(404, 'NOT_FOUND', 'Presence 없음', { resource: 'presence' });
      }
      if (!content.trim()) return fail(400, 'MESSAGE_INVALID_CONTENT', '내용이 비어 있어요');
      const message: PublicMessage = {
        kind: 'public',
        id: this.nextId(),
        senderId: this.me.id,
        content,
        links: extractLinks(content),
        createdAt: Date.now(),
        position: this.myPosition,
      };
      this.emit('chat.public', {
        ...message,
        sender: { nickname: this.me.nickname, kind: this.me.kind },
      });
      return json(201, message);
    }

    // ---------- DM ----------
    if (method === 'GET' && path === '/dm') {
      const byPeer = new Map<string, DmMessage[]>();
      for (const msg of this.dms) {
        const peer = msg.conversationId.replace(/^c_/, '');
        byPeer.set(peer, [...(byPeer.get(peer) ?? []), msg]);
      }
      const items = [...byPeer.entries()].map(([peerId, msgs]) => {
        const last = msgs[msgs.length - 1]!;
        const peer = this.others.get(peerId);
        return {
          id: `c_${peerId}`,
          participantIds: [this.me.id, peerId],
          lastMessage: last,
          unreadCount: msgs.filter((x) => x.senderId === peerId && x.readAt === undefined).length,
          updatedAt: last.createdAt,
          peer: peer
            ? this.userOf(peer)
            : this.userOf({ id: peerId, nickname: peerId, online: false }),
        };
      });
      return json(200, { items, nextCursor: null });
    }
    m = /^\/dm\/([^/]+)\/messages$/.exec(path);
    if (m) {
      const peerId = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        const peer = this.others.get(peerId);
        if (!peer) return fail(404, 'NOT_FOUND', '사용자 없음', { resource: 'user' });
        const items = this.dms.filter((x) => x.conversationId === `c_${peerId}`).reverse();
        return json(200, { items, nextCursor: null });
      }
      if (method === 'POST') {
        if (rateLimited()) return;
        const content = (body as { content?: string } | null)?.content ?? '';
        if (peerId === this.me.id) {
          return fail(400, 'VALIDATION_FAILED', '자기 자신', { fields: { userId: 'invalid' } });
        }
        const peer = this.others.get(peerId);
        if (!peer) return fail(404, 'NOT_FOUND', '사용자 없음', { resource: 'user' });
        if (peer.status === 'suspended') return fail(403, 'FORBIDDEN', '정지 회원');
        if (!content.trim()) return fail(400, 'MESSAGE_INVALID_CONTENT', '내용이 비어 있어요');
        const message: DmMessage = {
          kind: 'dm',
          id: this.nextId(),
          conversationId: `c_${peerId}`,
          senderId: this.me.id,
          content,
          links: extractLinks(content),
          createdAt: Date.now(),
        };
        this.dms.push(message);
        this.emit('chat.dm', { ...message, sender: this.me, peerId });
        return json(201, message);
      }
    }
    m = /^\/dm\/messages\/([^/]+)\/recall$/.exec(path);
    if (method === 'POST' && m) {
      const idx = this.dms.findIndex((x) => x.id === m![1] && x.senderId === this.me.id);
      if (idx === -1) return fail(404, 'NOT_FOUND', '메시지 없음', { resource: 'message' });
      if (this.dms[idx]!.readAt !== undefined)
        return fail(409, 'MESSAGE_ALREADY_READ', '이미 읽음');
      const [removed] = this.dms.splice(idx, 1);
      this.emit('chat.dm.recalled', {
        conversationId: removed!.conversationId,
        messageId: removed!.id,
      });
      return noContent();
    }
    m = /^\/dm\/([^/]+)\/read$/.exec(path);
    if (method === 'POST' && m) return noContent();

    // ---------- 그룹 ----------
    if (method === 'GET' && path === '/groups') {
      const items = [...this.groups.values()].map(({ group, messages }) => ({
        ...group,
        unreadCount: 0,
        ...(messages.length ? { lastMessage: messages[messages.length - 1] } : {}),
      }));
      return json(200, { items });
    }
    if (method === 'POST' && path === '/groups') {
      const name = ((body as { name?: string } | null)?.name ?? '').trim();
      if ([...name].length < 2 || [...name].length > 100) {
        return fail(400, 'VALIDATION_FAILED', '이름', { fields: { name: 'length' } });
      }
      const group: Group = {
        id: this.nextId(),
        name,
        ownerId: this.me.id,
        memberCount: 1,
        createdAt: Date.now(),
      };
      this.groups.set(group.id, {
        group,
        members: [
          {
            groupId: group.id,
            userId: this.me.id,
            role: 'owner',
            joinedAt: Date.now(),
            user: this.me,
          },
        ],
        messages: [],
      });
      return json(201, group);
    }
    m = /^\/groups\/([^/]+)(?:\/(members|messages|read)(?:\/([^/]+))?)?$/.exec(path);
    if (m) {
      const entry = this.groups.get(decodeURIComponent(m[1]!));
      if (!entry) return fail(404, 'NOT_FOUND', '그룹 없음', { resource: 'group' });
      const sub = m[2];
      const subId = m[3] ? decodeURIComponent(m[3]) : undefined;
      if (!sub) {
        if (method === 'GET') return json(200, { group: entry.group, members: entry.members });
        if (method === 'PATCH') {
          entry.group.name = ((body as { name?: string } | null)?.name ?? '').trim();
          this.emit('group.updated', { ...entry.group, members: entry.members });
          return json(200, entry.group);
        }
        if (method === 'DELETE') {
          this.groups.delete(entry.group.id);
          this.emit('group.removed', { groupId: entry.group.id, reason: 'dissolved' });
          return noContent();
        }
      }
      if (sub === 'members' && method === 'POST') {
        const userId = (body as { userId?: string } | null)?.userId;
        const target = userId ? this.others.get(userId) : undefined;
        if (!target) return fail(404, 'NOT_FOUND', '사용자 없음', { resource: 'user' });
        if (entry.members.length >= this.config.maxGroupMembers)
          return fail(409, 'GROUP_FULL', '인원 초과');
        const member: GroupMemberWithUser = {
          groupId: entry.group.id,
          userId: target.id,
          role: 'member',
          joinedAt: Date.now(),
          user: this.userOf(target),
        };
        entry.members.push(member);
        entry.group.memberCount = entry.members.length;
        const { user: _user, ...plain } = member;
        return json(201, plain);
      }
      if (sub === 'members' && method === 'DELETE' && subId) {
        entry.members = entry.members.filter((x) => x.userId !== subId);
        entry.group.memberCount = entry.members.length;
        if (entry.members.length === 0) this.groups.delete(entry.group.id);
        return noContent();
      }
      if (sub === 'messages' && method === 'GET') {
        return json(200, { items: [...entry.messages].reverse(), nextCursor: null });
      }
      if (sub === 'messages' && method === 'POST') {
        if (rateLimited()) return;
        const content = (body as { content?: string } | null)?.content ?? '';
        if (!content.trim()) return fail(400, 'MESSAGE_INVALID_CONTENT', '내용이 비어 있어요');
        const message: GroupMessage = {
          kind: 'group',
          id: this.nextId(),
          groupId: entry.group.id,
          senderId: this.me.id,
          content,
          links: extractLinks(content),
          createdAt: Date.now(),
        };
        entry.messages.push(message);
        this.emit('chat.group', { ...message, sender: this.me });
        return json(201, message);
      }
      if (sub === 'read' && method === 'POST') return noContent();
    }

    return fail(404, 'NOT_FOUND', `경로 없음: ${method} ${path}`);
  }

  private profileOf(user: FakeUser) {
    return {
      user: this.userOf(user),
      online: user.online,
      ...(user.online
        ? { position: { mapId: this.mapId, ...(user.position ?? SPAWN), dir: 'down' } }
        : {}),
    };
  }

  private emitTo(
    stream: http.ServerResponse,
    type: string,
    payload: unknown,
    idOverride?: string,
  ): void {
    const id = idOverride ?? String(++this.eventSeq);
    const data = JSON.stringify({ id, type, ts: Date.now(), payload });
    stream.write(`id: ${id}\nevent: ${type}\ndata: ${data}\n\n`);
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 테스트에서 특정 조건을 짧게 폴링 */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

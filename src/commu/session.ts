import { log } from '../logger.js';
import { AuthManager } from './auth.js';
import { systemClock, type Clock, type ClockTimer } from './clock.js';
import { CommuClient } from './client.js';
import type { CommuConfig } from './config.js';
import {
  CommuApiError,
  CommuDisabledError,
  CommuEndedError,
  CommuNotConnectedError,
  type EndedReason,
} from './errors.js';
import { CommuHttp } from './http.js';
import { Inbox, type InboxItem } from './inbox.js';
import type { MapGrid } from './map.js';
import { blockedBeforeMoving, Mover, type MoveResult } from './mover.js';
import { createPathGrid, freeTileNear } from './pathfinding.js';
import {
  mapGridSchema,
  presenceLeftPayloadSchema,
  presenceSchema,
  presenceUpdatedPayloadSchema,
  worldPositionsPayloadSchema,
  worldSnapshotPayloadSchema,
  type Me,
  type Position,
  type PublicMessage,
  type ServerConfig,
  type SseEnvelope,
} from './schemas.js';
import { SseClient, type SseState } from './sse.js';
import contractMap from './contract/maps/main.json' with { type: 'json' };
import { chebyshev, WorldState, type NearbyPresence, type TilePoint } from './world.js';

/** ARCHITECTURE 3: idle → entering → online → leaving → idle. ended 는 복구 없음 */
export type SessionState = 'idle' | 'entering' | 'online' | 'leaving' | 'ended';
export type LeaveReason = 'tool' | 'idle' | 'shutdown' | 'presence-lost';

export interface SessionDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  requestTimeoutMs?: number;
  /** 맵 격자. 기본은 계약 자산(src/commu/contract/maps/main.json) */
  map?: MapGrid;
  /** 이동 속도·배칭 (기본 150ms/타일 · 200ms 전송 · 40타일, 테스트용) */
  move?: { tileMs?: number; batchMs?: number; maxTiles?: number };
  /** SSE 유휴 타임아웃·백오프 (테스트용) */
  sse?: { idleTimeoutMs?: number; backoff?: { initialMs: number; maxMs: number; jitter: number } };
  inboxCapacity?: number;
}

export interface SessionStatus {
  state: SessionState;
  endedReason: EndedReason | null;
  me: { id: string; nickname: string; kind: 'human' | 'ai' } | null;
  mapId: string | null;
  position: Position | null;
  proximityRadius: number | null;
  maxMessageLength: number | null;
  onlineCount: number;
  nearbyCount: number;
  /** read_inbox 가 아직 돌려주지 않은 DM·그룹 메시지 수 */
  unread: { dm: number; group: number };
  inbox: { size: number; dropped: number; latestCursor: number };
  /** 마지막 429 뒤 남은 대기 시간. 없으면 null */
  rateLimit: { retryAfterSec: number } | null;
  idle: { minutes: number; leaveInSec: number | null };
  sse: SseState | null;
  lastEventId: string | null;
  baseUrl: string;
  /** commu_move_to 진행 중 */
  moving: boolean;
}

/** commu_move_to 입력 (MCP.md 5.3): 타일 좌표 또는 사람 */
export type MoveTarget = { x: number; y: number } | { userId: string };

export interface MoveToResult extends MoveResult {
  /** { userId } 목적지일 때 그 사람과의 거리 (체비쇼프) 와 근접 반경 안 여부 */
  user?: { userId: string; distance: number; withinProximity: boolean };
}

export interface SayResult {
  message: PublicMessage;
  /** 반경 안에 있어 들었을 접속자 (닉네임은 다른 사용자가 쓴 글 — 도구가 untrusted 로 감싼다) */
  heardBy: NearbyPresence[];
}

/**
 * AI 계정 하나의 Commu 세션 (MCP.md 3): 토큰 교환 → SSE 유지 → 월드·보관함 갱신, 이동·발화 같은 복합 동작.
 * 도구는 모두 이 객체를 통해 Commu 를 만진다. 행동 도구는 ensureOnline() 으로 자동 입장하고,
 * 모든 도구 호출은 touch() 로 유휴 타이머를 리셋한다.
 */
export class CommuSession {
  readonly world = new WorldState();
  readonly inbox: Inbox;
  readonly http: CommuHttp;
  readonly auth: AuthManager;
  readonly client: CommuClient;
  readonly map: MapGrid;
  state: SessionState = 'idle';

  private sse: SseClient | null = null;
  private entering: Promise<SessionStatus> | null = null;
  private leaving: Promise<void> | null = null;
  /** 행동 도구·이동을 호출 순서대로 하나씩 (위치 경쟁 방지, ARCHITECTURE 6) */
  private actions: Promise<unknown> = Promise.resolve();
  private moving: Promise<unknown> | null = null;
  private idleTimer: ClockTimer | null = null;
  private idleDeadline: number | null = null;
  private lastSeq = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly mover: Mover;
  private readonly sseOptions: SessionDeps['sse'];

  constructor(
    readonly config: CommuConfig,
    deps: SessionDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.clock = deps.clock ?? systemClock;
    this.sseOptions = deps.sse;
    this.http = new CommuHttp(
      config.apiBaseUrl,
      this.fetchImpl,
      deps.requestTimeoutMs ?? 10_000,
      () => this.clock.now(),
    );
    this.auth = new AuthManager(this.http, config.aiToken, this.clock, (reason) =>
      this.onAuthEnded(reason),
    );
    this.http.tokenSource = this.auth;
    this.client = new CommuClient(this.http);
    this.map = deps.map ?? loadContractMap();
    this.mover = new Mover({
      clock: this.clock,
      map: this.map,
      occupied: () => this.world.others().map((p) => p.position),
      putPosition: (body) => this.client.putPosition(body),
      nextSeq: () => {
        this.lastSeq = Math.max(this.clock.now(), this.lastSeq + 1);
        return this.lastSeq;
      },
      onAccepted: (position) => this.world.setMyPosition(position, this.clock.now()),
      ...(deps.move?.tileMs !== undefined ? { tileMs: deps.move.tileMs } : {}),
      ...(deps.move?.batchMs !== undefined ? { batchMs: deps.move.batchMs } : {}),
      ...(deps.move?.maxTiles !== undefined ? { maxTiles: deps.move.maxTiles } : {}),
    });
    this.inbox = new Inbox({
      capacity: deps.inboxCapacity ?? 500,
      now: () => this.clock.now(),
    });
  }

  get me(): Me | null {
    return this.auth.me;
  }

  get serverConfig(): ServerConfig | null {
    return this.auth.config;
  }

  get online(): boolean {
    return this.state === 'online';
  }

  get endedReason(): EndedReason | null {
    return this.auth.ended;
  }

  /** 모든 commu_* 도구 호출이 부른다 — 유휴 타이머 리셋 (MCP.md 3.3) */
  touch(): void {
    if (this.online) this.armIdle();
  }

  /** 명시적 입장 (MCP.md 3.1). 이미 online 이면 상태만. 동시 호출은 한 번의 입장을 공유 */
  enter(): Promise<SessionStatus> {
    if (!this.config.enabled) return Promise.reject(new CommuDisabledError());
    if (this.auth.ended) return Promise.reject(new CommuEndedError(this.auth.ended));
    if (this.online) {
      this.armIdle();
      return Promise.resolve(this.status());
    }
    if (!this.entering) {
      this.entering = this.doEnter().finally(() => {
        this.entering = null;
      });
    }
    return this.entering;
  }

  /**
   * REST 읽기 도구용 (C2): 입장(SSE) 없이 접근 토큰만 확보한다. 월드에 나타나지 않고 히스토리·검색을 할 수 있다.
   * 토큰 없음·폐기·정지는 다른 도구와 같은 오류
   */
  async authorize(): Promise<void> {
    if (!this.config.enabled) throw new CommuDisabledError();
    if (this.auth.ended) throw new CommuEndedError(this.auth.ended);
    if (!this.auth.authenticated) await this.auth.exchange();
  }

  /**
   * read_inbox 가 돌려준 DM·그룹 메시지를 대화·그룹마다 마지막 것까지 읽음 처리한다 (MCP.md 5.2, ARCHITECTURE 5).
   * 보관함은 도착 순서라 마지막 항목이 그 대화의 최신이다 (id 는 불투명 문자열이라 비교하지 않는다).
   * 실패해도 예외를 던지지 않고 stderr 경고만 — 도구는 성공으로 돌려준다
   */
  async markRead(items: readonly InboxItem[]): Promise<{ dm: number; group: number }> {
    const dm = new Map<string, string>();
    const group = new Map<string, string>();
    for (const item of items) {
      if (item.type === 'dm') dm.set(item.from.userId, item.messageId);
      else if (item.type === 'group') group.set(item.groupId, item.messageId);
    }
    if (dm.size === 0 && group.size === 0) return { dm: 0, group: 0 };
    try {
      await this.authorize();
    } catch (error) {
      log.warn('read_inbox: 읽음 처리를 건너뜀', {
        reason: error instanceof Error ? error.name : 'error',
      });
      return { dm: 0, group: 0 };
    }
    const settle = async (kind: 'dm' | 'group', calls: Promise<void>[]) => {
      const results = await Promise.allSettled(calls);
      for (const result of results) {
        if (result.status === 'rejected') {
          const e: unknown = result.reason;
          log.warn('read_inbox: 읽음 처리 실패', {
            kind,
            ...(e instanceof CommuApiError ? { status: e.status, code: e.code } : {}),
          });
        }
      }
      return results.filter((r) => r.status === 'fulfilled').length;
    };
    const [dmCount, groupCount] = await Promise.all([
      settle(
        'dm',
        [...dm].map(([userId, messageId]) => this.client.readDm(userId, messageId)),
      ),
      settle(
        'group',
        [...group].map(([groupId, messageId]) => this.client.readGroup(groupId, messageId)),
      ),
    ]);
    return { dm: dmCount, group: groupCount };
  }

  /**
   * 행동 도구의 본문 (MCP.md 3.1·7): 앞선 행동·이동이 끝난 뒤 차례로 실행한다 (이동 중 발화·DM 이 끼어들지 않게, ARCHITECTURE 6).
   * 입장돼 있지 않으면 자동 입장하고 fn 을 부른다. 서버가 `404 NOT_FOUND resource: 'presence'` 로 답하면(SSE 가 조용히 끊겨
   * 유예가 지난 경우 등) 다시 입장해 한 번만 재시도한다
   */
  act<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(() => this.runAction(fn));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.actions.then(fn, fn);
    this.actions = run.catch(() => undefined);
    return run;
  }

  private async runAction<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureOnline();
    try {
      return await fn();
    } catch (error) {
      if (!isPresenceMissing(error)) throw error;
      log.info('presence missing on the server — re-entering once');
      await this.leave('presence-lost');
      await this.enter();
      return fn();
    }
  }

  /** 행동 도구용: 입장돼 있지 않으면 자동 입장 */
  async ensureOnline(): Promise<void> {
    if (this.online) {
      this.armIdle();
      return;
    }
    await this.enter();
  }

  /** 퇴장 (MCP.md 3.3): SSE 를 닫는다 → 서버가 유예 뒤 presence.left. 접근 토큰·보관함은 유지 */
  leave(reason: LeaveReason = 'tool'): Promise<void> {
    if (!this.leaving) {
      this.leaving = this.doLeave(reason).finally(() => {
        this.leaving = null;
      });
    }
    return this.leaving;
  }

  status(): SessionStatus {
    const me = this.me;
    const myPresence = this.world.me();
    const radius = this.serverConfig?.proximityRadius ?? null;
    const retryAfterSec = this.http.rateLimitRemainingSec();
    return {
      state: this.state,
      endedReason: this.auth.ended,
      me: me ? { id: me.id, nickname: me.nickname, kind: me.kind } : null,
      mapId: this.world.mapId,
      position: myPresence?.position ?? null,
      proximityRadius: radius,
      maxMessageLength: this.serverConfig?.maxMessageLength ?? null,
      onlineCount: this.world.size,
      nearbyCount: radius === null ? 0 : this.world.nearby(radius).filter((p) => p.inRadius).length,
      unread: this.inbox.unread(),
      inbox: {
        size: this.inbox.size,
        dropped: this.inbox.dropped,
        latestCursor: this.inbox.latestCursor,
      },
      rateLimit: retryAfterSec === null ? null : { retryAfterSec },
      idle: {
        minutes: this.config.idleMinutes,
        leaveInSec:
          this.idleDeadline === null
            ? null
            : Math.max(0, Math.ceil((this.idleDeadline - this.clock.now()) / 1000)),
      },
      sse: this.sse?.state ?? null,
      lastEventId: this.sse?.lastEventId ?? null,
      baseUrl: this.config.apiBaseUrl,
      moving: this.moving !== null,
    };
  }

  /** 내 Presence. 입장 전이면 예외 (메모리만 보는 읽기 도구용) */
  requirePresence() {
    const me = this.world.me();
    if (!me) throw new CommuNotConnectedError();
    return me;
  }

  /**
   * commu_move_to (MCP.md 5.3): 좌표 또는 사람 옆 빈 칸까지 A* 경로로 걷는다 (mover.ts). 다른 행동과 같은 줄에서 차례로
   * 실행되고(act), 입장 전이면 자동 입장, 서버에 Presence 가 없으면 재입장 1회. 결과 position 이 서버가 인정한 내 위치
   */
  moveTo(target: MoveTarget): Promise<MoveToResult> {
    const current: Promise<MoveToResult> = this.act(() => this.doMove(target)).finally(() => {
      if (this.moving === current) this.moving = null;
    });
    this.moving = current;
    return current;
  }

  private async doMove(target: MoveTarget): Promise<MoveToResult> {
    const me = this.requirePresence();
    const from = me.position;
    if (!('userId' in target)) return this.mover.run(from, target);

    const { userId } = target;
    if (userId === me.userId) throw new Error('자기 자신에게는 이동할 수 없습니다');
    const located = await this.locateUser(userId, from.mapId);
    if ('reason' in located) return blockedBeforeMoving(from, from, located.reason);
    const grid = createPathGrid(
      this.map,
      this.world.others().map((p) => p.position),
    );
    const goal = freeTileNear(grid, located.tile, from);
    if (!goal) return blockedBeforeMoving(from, located.tile, 'no_free_tile');
    const result = await this.mover.run(from, goal, { face: located.tile });
    // 걷는 동안 그 사람이 움직였을 수 있다 — 거리는 지금 월드 기준
    const now = this.world.others().find((p) => p.userId === userId)?.position ?? located.tile;
    const distance = chebyshev(result.position, now);
    const radius = this.serverConfig?.proximityRadius ?? 5;
    return { ...result, user: { userId, distance, withinProximity: distance <= radius } };
  }

  /** 월드에 있으면 그 위치, 없으면 GET /users/{id} (없는 사람은 404 NOT_FOUND user 그대로) */
  private async locateUser(
    userId: string,
    mapId: string,
  ): Promise<{ tile: TilePoint } | { reason: 'user_offline' | 'other_map' }> {
    const known = this.world.others().find((p) => p.userId === userId);
    if (known) return { tile: known.position };
    const profile = await this.client.getUser(userId);
    if (!profile.online || !profile.position) return { reason: 'user_offline' };
    if (profile.position.mapId !== mapId) return { reason: 'other_map' };
    return { tile: profile.position };
  }

  /** 근접 공개 대화. 반경 안에 있어 들었을 접속자 닉네임을 함께 돌려준다 */
  async say(content: string): Promise<SayResult> {
    const message = await this.act(() => this.client.sendPublic(content));
    const radius = this.serverConfig?.proximityRadius ?? 5;
    this.world.setMyPosition(message.position, this.clock.now());
    const heardBy = this.world.nearby(radius, message.position).filter((p) => p.inRadius);
    return { message, heardBy };
  }

  /** SSE 단절 뒤 재동기화 (API_CONTRACT 3.5 의 1번. DM·그룹 목록은 도구가 호출 때마다 새로 읽는다) */
  async resync(reason: string): Promise<void> {
    try {
      const mapId = this.world.mapId ?? this.serverConfig?.defaultMapId ?? 'main';
      const res = await this.client.getPresences(mapId);
      this.world.applySnapshot(res, this.clock.now());
      log.info(`world resynced (${reason})`);
    } catch (error) {
      log.warn('resync failed', error);
    }
  }

  private async doEnter(): Promise<SessionStatus> {
    if (this.leaving) await this.leaving;
    this.state = 'entering';
    try {
      if (!this.auth.authenticated) await this.auth.exchange();
      this.world.myUserId = this.auth.me?.id ?? null;
      this.inbox.myUserId = this.world.myUserId;

      await this.sse?.close();
      this.sse = new SseClient({
        baseUrl: this.config.apiBaseUrl,
        fetchImpl: this.fetchImpl,
        requestTicket: async () => (await this.client.requestTicket()).ticket,
        onEvent: (envelope) => this.handleEvent(envelope),
        onResync: (reason) => void this.resync(reason),
        onSuspended: () => {
          log.warn('AI suspended: SSE closed by server');
          this.auth.markEnded('suspended');
        },
        onStateChange: (state) => log.debug(`sse ${state}`),
        onError: (error) => log.warn('sse error', error),
        sleep: (ms) => this.clock.sleep(ms),
        now: () => this.clock.now(),
        ...(this.sseOptions?.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: this.sseOptions.idleTimeoutMs }
          : {}),
        ...(this.sseOptions?.backoff ? { backoff: this.sseOptions.backoff } : {}),
      });
      await this.sse.connect();
      this.state = 'online';
      this.armIdle();
      log.info(`entered Commu as ${this.auth.me?.nickname ?? '?'}`);
      return this.status();
    } catch (error) {
      this.sse = null;
      this.state = error instanceof CommuEndedError ? 'ended' : 'idle';
      throw error;
    }
  }

  private async doLeave(reason: LeaveReason): Promise<void> {
    if (this.entering) {
      try {
        await this.entering;
      } catch {
        // 입장이 실패했으면 이미 idle 또는 ended 다
      }
    }
    this.clearIdle();
    if (this.state === 'idle' || this.state === 'ended') return;
    this.state = 'leaving';
    const sse = this.sse;
    this.sse = null;
    await sse?.close();
    this.world.clear();
    if (this.state === 'leaving') this.state = 'idle';
    log.info(`left Commu (${reason})`);
  }

  /** MCP.md 3.4: 정지·토큰 폐기 → 복구 없이 ended. SSE 도 닫는다 (서버가 이미 닫았을 수도) */
  private onAuthEnded(reason: EndedReason): void {
    this.state = 'ended';
    this.clearIdle();
    const sse = this.sse;
    this.sse = null;
    void sse?.close();
    log.warn(`session ended: ${reason}`);
  }

  private armIdle(): void {
    this.clearIdle();
    const ms = this.config.idleMinutes * 60_000;
    this.idleDeadline = this.clock.now() + ms;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      this.idleDeadline = null;
      log.info(`idle for ${this.config.idleMinutes}m, leaving`);
      void this.leave('idle');
    }, ms);
  }

  private clearIdle(): void {
    this.idleTimer?.cancel();
    this.idleTimer = null;
    this.idleDeadline = null;
  }

  private handleEvent(envelope: SseEnvelope): void {
    try {
      switch (envelope.type) {
        case 'world.snapshot':
          this.world.applySnapshot(
            worldSnapshotPayloadSchema.parse(envelope.payload),
            this.clock.now(),
          );
          break;
        case 'world.positions':
          this.world.applyPositions(worldPositionsPayloadSchema.parse(envelope.payload));
          break;
        case 'presence.joined':
          this.world.applyJoined(presenceSchema.parse(envelope.payload));
          break;
        case 'presence.left':
          this.world.applyLeft(presenceLeftPayloadSchema.parse(envelope.payload));
          break;
        case 'presence.updated':
          this.world.applyUpdated(presenceUpdatedPayloadSchema.parse(envelope.payload));
          break;
        default:
          break;
      }
    } catch (error) {
      log.warn(`failed to apply ${envelope.type}`, error);
    }
    try {
      this.inbox.ingest(envelope);
    } catch (error) {
      // 계약 스키마와 안 맞는 이벤트는 경고만 하고 연결은 유지한다 (ARCHITECTURE 4)
      log.warn(`inbox skipped ${envelope.type}`, error);
    }
  }
}

/** 계약 자산 맵 (프론트 src/assets/maps/main.json 의 동기화 사본). 빌드에서는 dist/commu/contract/maps/main.json */
function loadContractMap(): MapGrid {
  const parsed = mapGridSchema.safeParse(contractMap);
  if (!parsed.success) {
    throw new Error(
      `계약 자산 맵을 읽을 수 없습니다 (src/commu/contract/maps/main.json): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** MCP.md 7: 입장(Presence)이 서버에 없다는 응답 — 행동 도구는 다시 입장해 한 번 재시도한다 */
function isPresenceMissing(error: unknown): boolean {
  return (
    error instanceof CommuApiError &&
    error.code === 'NOT_FOUND' &&
    error.details?.['resource'] === 'presence'
  );
}

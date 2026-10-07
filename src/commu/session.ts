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
import { findPath, isBlocked, planHops, straightHops, type Hop, type MapGrid } from './map.js';
import {
  mapGridSchema,
  positionRejectedDetailsSchema,
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
  /** 맵 격자. undefined 면 계약 자산(src/commu/contract/maps/main.json)을 쓰고, null 이면 맵 없이 동작 */
  map?: MapGrid | null;
  /** 이동 요청 사이 간격 (레이트 리밋 10회/초 → 기본 120ms) */
  hopIntervalMs?: number;
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
  mapLoaded: boolean;
}

export interface MoveRejection extends TilePoint {
  reason: string;
}

export interface MoveResult {
  reached: boolean;
  from: Position;
  position: Position;
  distanceToTarget: number;
  hops: number;
  plannedHops: number;
  pathLength: number | null;
  rejections: MoveRejection[];
  stoppedBecause?: string;
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
  readonly map: MapGrid | null;
  state: SessionState = 'idle';

  private sse: SseClient | null = null;
  private entering: Promise<SessionStatus> | null = null;
  private leaving: Promise<void> | null = null;
  private idleTimer: ClockTimer | null = null;
  private idleDeadline: number | null = null;
  private lastSeq = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly hopIntervalMs: number;
  private readonly sseOptions: SessionDeps['sse'];

  constructor(
    readonly config: CommuConfig,
    deps: SessionDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.clock = deps.clock ?? systemClock;
    this.hopIntervalMs = deps.hopIntervalMs ?? 120;
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
    this.map = deps.map !== undefined ? deps.map : loadContractMap();
    this.inbox = new Inbox({
      capacity: deps.inboxCapacity ?? 500,
      now: () => this.clock.now(),
      resolveKind: (userId) => this.world.kindOf(userId),
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
   * 행동 도구의 본문 (MCP.md 3.1·7): 입장돼 있지 않으면 자동 입장하고 fn 을 부른다. 서버가
   * `404 NOT_FOUND resource: 'presence'` 로 답하면(SSE 가 조용히 끊겨 유예가 지난 경우 등) 다시 입장해 한 번만 재시도한다
   */
  async act<T>(fn: () => Promise<T>): Promise<T> {
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
      mapLoaded: this.map !== null,
    };
  }

  /** 내 Presence. 입장 전이면 예외 (메모리만 보는 읽기 도구용) */
  requirePresence() {
    const me = this.world.me();
    if (!me) throw new CommuNotConnectedError();
    return me;
  }

  /**
   * 목적지까지 이동. 맵이 있으면 BFS 경로를 3칸씩 끊어 보내고, 없으면 직선으로 간다.
   * 409 POSITION_REJECTED 는 서버 인정 위치로 보정한다. 목적지가 점유돼 있으면 직전 타일에서 멈춘다.
   * (C4 에서 MCP.md 5.3 의 mover 로 교체)
   */
  async moveTo(target: TilePoint, opts: { maxHops?: number } = {}): Promise<MoveResult> {
    await this.ensureOnline();
    const me = this.requirePresence();
    const from = me.position;
    const mapId = from.mapId;
    const occupied = (p: TilePoint) => this.world.occupantAt(p, me.userId) !== undefined;

    let hops: Hop[];
    let pathLength: number | null = null;
    if (this.map) {
      if (isBlocked(this.map, target)) {
        return this.moveResult(from, from, target, 0, 0, null, [], 'collision');
      }
      const path = findPath(this.map, from, target, occupied);
      if (path === null) {
        return this.moveResult(from, from, target, 0, 0, null, [], 'no_path');
      }
      if (occupied(target)) path.pop();
      pathLength = path.length;
      hops = planHops(from, path);
    } else {
      hops = straightHops(from, target);
    }

    const maxHops = opts.maxHops ?? 100;
    const planned = hops.slice(0, maxHops);
    const rejections: MoveRejection[] = [];
    let current: Position = from;
    let accepted = 0;
    let stoppedBecause: string | undefined;

    for (const hop of planned) {
      const seq = Math.max(this.clock.now(), this.lastSeq + 1);
      this.lastSeq = seq;
      try {
        await this.client.putPosition({ mapId, x: hop.x, y: hop.y, dir: hop.dir, seq });
        current = { mapId, x: hop.x, y: hop.y, dir: hop.dir };
        this.world.setMyPosition(current, this.clock.now());
        accepted++;
      } catch (error) {
        if (!(error instanceof CommuApiError) || error.code !== 'POSITION_REJECTED') throw error;
        const details = positionRejectedDetailsSchema.safeParse(error.details);
        const reason = details.success ? details.data.reason : 'unknown';
        if (details.success) {
          current = details.data.position;
          this.world.setMyPosition(current, this.clock.now());
        }
        rejections.push({ x: hop.x, y: hop.y, reason });
        if (reason === 'occupied' || reason === 'collision' || rejections.length >= 3) {
          stoppedBecause = reason;
          break;
        }
      }
      if (this.hopIntervalMs > 0) await this.clock.sleep(this.hopIntervalMs);
    }
    if (!stoppedBecause && hops.length > planned.length) stoppedBecause = 'max_hops';

    return this.moveResult(
      from,
      current,
      target,
      accepted,
      planned.length,
      pathLength,
      rejections,
      stoppedBecause,
    );
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

  private moveResult(
    from: Position,
    position: Position,
    target: TilePoint,
    hops: number,
    plannedHops: number,
    pathLength: number | null,
    rejections: MoveRejection[],
    stoppedBecause?: string,
  ): MoveResult {
    const distanceToTarget = chebyshev(position, target);
    return {
      reached: distanceToTarget === 0,
      from,
      position,
      distanceToTarget,
      hops,
      plannedHops,
      pathLength,
      rejections,
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
  }
}

/** 계약 자산 맵 (프론트 src/assets/maps/main.json 의 동기화 사본). 빌드에서는 dist/commu/contract/maps/main.json */
function loadContractMap(): MapGrid | null {
  try {
    return mapGridSchema.parse(contractMap);
  } catch (error) {
    log.warn('contract map could not be loaded; moving without pathfinding', error);
    return null;
  }
}

/** MCP.md 7: 입장(Presence)이 서버에 없다는 응답 — 행동 도구는 다시 입장해 한 번 재시도한다 */
function isPresenceMissing(error: unknown): boolean {
  return (
    error instanceof CommuApiError &&
    error.code === 'NOT_FOUND' &&
    error.details?.['resource'] === 'presence'
  );
}

import { log } from '../logger.js';
import { AuthManager } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import { CommuClient } from './client.js';
import type { CommuConfig } from './config.js';
import {
  CommuApiError,
  CommuDisabledError,
  CommuEndedError,
  CommuNotConnectedError,
} from './errors.js';
import { EventBuffer } from './events.js';
import { CommuHttp } from './http.js';
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
import { chebyshev, WorldState, type TilePoint } from './world.js';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'ended';

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
}

export interface SessionStatus {
  state: SessionState;
  sse: SseState | null;
  baseUrl: string;
  /** 정지·토큰 폐기로 끝났으면 그 이유 (MCP.md 3.4) */
  endedReason: 'suspended' | 'revoked' | null;
  me: { id: string; nickname: string; role: Me['role'] } | null;
  mapId: string | null;
  position: Position | null;
  proximityRadius: number | null;
  maxMessageLength: number | null;
  onlineCount: number;
  nearbyCount: number;
  lastEventId: string | null;
  bufferedEvents: number;
  latestEventCursor: number;
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
  heardBy: string[];
}

/**
 * 한 회원 계정의 Commu 참여 세션: 로그인 → SSE 유지 → 월드 상태·이벤트 버퍼 갱신, 이동·발화 같은 복합 동작.
 * 도구는 모두 이 객체를 통해 Commu 를 만진다.
 */
export class CommuSession {
  readonly world = new WorldState();
  readonly events = new EventBuffer();
  readonly http: CommuHttp;
  readonly auth: AuthManager;
  readonly client: CommuClient;
  readonly map: MapGrid | null;
  state: SessionState = 'disconnected';

  private sse: SseClient | null = null;
  private connecting: Promise<SessionStatus> | null = null;
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
    this.http = new CommuHttp(config.apiBaseUrl, this.fetchImpl, deps.requestTimeoutMs ?? 10_000);
    this.auth = new AuthManager(this.http, config.aiToken, this.clock);
    this.http.tokenSource = this.auth;
    this.client = new CommuClient(this.http);
    this.map = deps.map !== undefined ? deps.map : loadContractMap();
  }

  get me(): Me | null {
    return this.auth.me;
  }

  get serverConfig(): ServerConfig | null {
    return this.auth.config;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  /** 토큰 교환(필요 시) + SSE 연결. world.snapshot 을 받으면 돌아온다. 동시 호출은 하나를 공유 */
  connect(): Promise<SessionStatus> {
    if (!this.config.enabled) return Promise.reject(new CommuDisabledError());
    if (this.auth.ended) return Promise.reject(new CommuEndedError(this.auth.ended));
    if (this.connected) return Promise.resolve(this.status());
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  /** SSE 를 닫는다 (서버가 유예 뒤 presence.left). 접근 토큰은 유지해 다음 입장에 재사용한다 */
  async disconnect(): Promise<void> {
    const sse = this.sse;
    this.sse = null;
    if (this.state !== 'ended') this.state = 'disconnected';
    await sse?.close();
    this.world.clear();
  }

  status(): SessionStatus {
    const me = this.me;
    const myPresence = this.world.me();
    const radius = this.serverConfig?.proximityRadius ?? null;
    return {
      state: this.state,
      sse: this.sse?.state ?? null,
      baseUrl: this.config.apiBaseUrl,
      endedReason: this.auth.ended,
      me: me ? { id: me.id, nickname: me.nickname, role: me.role } : null,
      mapId: this.world.mapId,
      position: myPresence?.position ?? null,
      proximityRadius: radius,
      maxMessageLength: this.serverConfig?.maxMessageLength ?? null,
      onlineCount: this.world.size,
      nearbyCount: radius === null ? 0 : this.world.nearby(radius).filter((p) => p.inRadius).length,
      lastEventId: this.sse?.lastEventId ?? null,
      bufferedEvents: this.events.size,
      latestEventCursor: this.events.latestCursor,
      mapLoaded: this.map !== null,
    };
  }

  /** 내 Presence. SSE 가 아직 스냅샷을 못 받았으면 예외 */
  requirePresence() {
    const me = this.world.me();
    if (!me)
      throw new CommuNotConnectedError(
        '아직 월드 스냅샷을 받지 못했어요. 잠시 후 다시 시도하세요.',
      );
    return me;
  }

  /**
   * 목적지까지 이동. 맵이 있으면 BFS 경로를 3칸씩 끊어 보내고, 없으면 직선으로 간다.
   * 409 POSITION_REJECTED 는 서버 인정 위치로 보정한다. 목적지가 점유돼 있으면 직전 타일에서 멈춘다.
   */
  async moveTo(target: TilePoint, opts: { maxHops?: number } = {}): Promise<MoveResult> {
    await this.ensureConnected();
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
    await this.ensureConnected();
    const message = await this.client.sendPublic(content);
    const radius = this.serverConfig?.proximityRadius ?? 5;
    this.world.setMyPosition(message.position, this.clock.now());
    const heardBy = this.world
      .nearby(radius, message.position)
      .filter((p) => p.inRadius)
      .map((p) => p.nickname);
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

  private async doConnect(): Promise<SessionStatus> {
    this.state = 'connecting';
    try {
      if (!this.auth.authenticated) await this.auth.exchange();
      this.world.myUserId = this.auth.me?.id ?? null;

      await this.sse?.close();
      this.sse = new SseClient({
        baseUrl: this.config.apiBaseUrl,
        fetchImpl: this.fetchImpl,
        requestTicket: async () => (await this.client.requestTicket()).ticket,
        onEvent: (envelope) => this.handleEvent(envelope),
        onResync: (reason) => void this.resync(reason),
        onSuspended: () => {
          this.auth.markEnded('suspended');
          this.state = 'ended';
          log.warn('AI suspended: SSE closed by server');
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
      this.state = 'connected';
      log.info(`connected to Commu as ${this.auth.me?.nickname ?? '?'}`);
      return this.status();
    } catch (error) {
      this.state = error instanceof CommuEndedError ? 'ended' : 'disconnected';
      throw error;
    }
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
    this.events.push(envelope);
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

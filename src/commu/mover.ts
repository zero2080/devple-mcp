// commu_move_to 실행기 (MCP.md 5.3, ARCHITECTURE 6). 경로는 pathfinding.ts(A*), 걷기는 가상 시계로 타일당 150ms 를 흉내 내며
// 200ms 마다 현재 위치를 PUT /me/position 으로 보낸다 (프론트 positionBatcher 와 같은 배칭, seq = Date.now()).
// 한 요청에 담는 타일은 최대 3 — 서버 검증 max(3, elapsedMs/100) 을 어떤 타이밍에도 넘지 않는다 (API_CONTRACT 2.2).
// 땅은 Ground 로만 읽는다 (옛 맵 collision 또는 지상 월드 청크 — ground.ts, W6).
import type { Clock } from './clock.js';
import { CommuApiError } from './errors.js';
import type { Ground } from './ground.js';
import { directionTo } from './map.js';
import { createAreaPathGrid, findPath, isSameTile, manhattan } from './pathfinding.js';
import {
  positionRejectedDetailsSchema,
  type Direction,
  type Position,
  type PositionRejectedReason,
} from './schemas.js';
import type { TilePoint } from './world.js';

export const TILE_MS = 150;
export const BATCH_MS = 200;
/** 한 번의 move_to 로 걷는 최대 타일 수 (MCP.md 5.3: 더 멀면 partial) */
export const MAX_TILES = 40;
/** 한 요청에 담는 최대 타일 수 — 서버 검증 max(3, elapsedMs/100) 의 하한 (체비쇼프) */
export const MAX_TILES_PER_REQUEST = 3;
/** 장애물(409 또는 눈앞 점유)마다 경로를 다시 계산한다. 이 횟수를 다 쓴 뒤 장애물이면 blocked */
export const MAX_REPLANS = 3;

export type MoveStatus = 'arrived' | 'blocked' | 'partial';
export type BlockedReason =
  | 'collision'
  | 'not_ready'
  | 'no_path'
  | 'occupied'
  | 'too_far'
  | 'user_offline'
  | 'other_map'
  | 'no_free_tile'
  | 'unknown_place';

export interface MoveResult {
  status: MoveStatus;
  /** blocked 일 때만 */
  reason?: BlockedReason;
  from: Position;
  /** 서버가 인정한 최종 위치 */
  position: Position;
  /** 실제로 향한 목적지 (점유된 목적지는 직전 타일, { userId } 는 그 사람 옆 칸) */
  goal: TilePoint;
  /** 서버가 인정한 이동 타일 수 */
  tilesMoved: number;
  /** goal 까지 남은 맨해튼 거리 */
  remainingTiles: number;
  /** PUT /me/position 횟수 */
  requests: number;
  /** 409 POSITION_REJECTED 횟수 */
  rejections: number;
  /** 경로 재계산 횟수 */
  replans: number;
}

export interface MoverDeps {
  clock: Clock;
  /** 지금의 땅 (부를 때마다 — 지상 월드는 청크 캐시가 바뀐다) */
  ground(): Ground;
  /** 내 타일을 제외한 현재 점유 타일 (부를 때마다 최신 월드) */
  occupied(): TilePoint[];
  putPosition(body: Position & { seq: number }): Promise<void>;
  /** 단조 증가하는 seq (Date.now() 기반) */
  nextSeq(): number;
  /** 서버가 인정한 위치를 월드에 반영 */
  onAccepted(position: Position): void;
  /** 409 not_ready: 그 칸의 청크를 준비되지 않은 것으로 (다시 받을 때까지 벽 — MCP.md 5.3) */
  onNotReady?(tile: TilePoint): void;
  tileMs?: number;
  batchMs?: number;
  maxTiles?: number;
}

export interface MoveOptions {
  /** 도착한 뒤 바라볼 타일 ({ userId } 목적지의 그 사람) */
  face?: TilePoint;
  /**
   * true 를 돌려주면 다음 걸음 전에 멈추고 partial (commu_go_home 이 진행 중인 이동을 끝낸다 — MCP.md 5.3).
   * 아직 보내지 않은 걸음은 버린다 — 결과 position 은 서버가 인정한 마지막 위치
   */
  shouldStop?: () => boolean;
}

interface Route {
  path: TilePoint[];
  goal: TilePoint;
  face: TilePoint | undefined;
}

interface Rejected {
  reason: PositionRejectedReason;
  position: Position;
}

export class Mover {
  private readonly tileMs: number;
  private readonly batchMs: number;
  private readonly maxTiles: number;

  constructor(private readonly deps: MoverDeps) {
    this.tileMs = deps.tileMs ?? TILE_MS;
    this.batchMs = deps.batchMs ?? BATCH_MS;
    this.maxTiles = deps.maxTiles ?? MAX_TILES;
  }

  /**
   * from 에서 target 까지 걷는다. 목적지가 벽이면 blocked(collision), 다른 캐릭터가 서 있으면 직전 타일까지 가서 그쪽을 본다
   * (프론트 3.2.1). 길이 없으면 blocked(no_path). maxTiles 를 넘으면 partial.
   */
  async run(from: Position, target: TilePoint, options: MoveOptions = {}): Promise<MoveResult> {
    const mapId = from.mapId;
    const avoid: TilePoint[] = [];
    let acked: Position = from;
    let tilesMoved = 0;
    let requests = 0;
    let rejections = 0;
    let replans = 0;

    // goal 은 좌표만 — 목적지가 출발 위치(Position)와 같은 객체일 수 있다(이미 장소 안·바로 옆이 점유). 도구 출력 스키마가 x·y 만 받는다
    const result = (status: MoveStatus, goal: TilePoint, reason?: BlockedReason): MoveResult => ({
      status,
      ...(reason ? { reason } : {}),
      from,
      position: acked,
      goal: { x: goal.x, y: goal.y },
      tilesMoved,
      remainingTiles: manhattan(acked, goal),
      requests,
      rejections,
      replans,
    });

    const ground = this.deps.ground();
    if (ground.isWall(target)) return result('blocked', target, ground.wallReason(target));

    const plan = (start: TilePoint): Route | null => {
      const ground = this.deps.ground();
      const grid = createAreaPathGrid(
        ground,
        ground.searchArea(start, target),
        this.deps.occupied(),
        avoid,
      );
      const goalOccupied = grid.isOccupied(target) && !isSameTile(target, start);
      const search = findPath(grid, start, target, { allowGoalOccupied: goalOccupied });
      if (!search.reachable) return null;
      const path = search.path;
      let goal = target;
      let face = options.face;
      if (goalOccupied) {
        path.pop();
        goal = path[path.length - 1] ?? start;
        face = target;
      }
      return { path, goal, face };
    };

    const first = plan(from);
    if (!first) return result('blocked', target, 'no_path');
    if (first.path.length === 0) return result('arrived', first.goal);
    let route: Route = first;

    // 가상 위치: 걸었지만 아직 안 보냈을 수 있다. 서버가 거부하면 acked 로 되돌린다
    let current: TilePoint = from;
    let dir: Direction = from.dir;
    let unsent = 0;
    let walked = 0;
    let index = 0;
    let nextSendAt = this.deps.clock.now() + this.batchMs;

    /** 장애물: 재계산 횟수가 남았으면 현재 위치에서 다시 계산, 아니면 blocked */
    const replan = (reason: BlockedReason): MoveResult | null => {
      if (replans >= MAX_REPLANS) return result('blocked', route.goal, reason);
      replans += 1;
      const next = plan(current);
      if (!next) return result('blocked', route.goal, 'no_path');
      route = next;
      index = 0;
      return null;
    };

    for (;;) {
      if (index >= route.path.length) {
        return result('arrived', route.goal);
      }
      if (options.shouldStop?.() === true || walked >= this.maxTiles) {
        return result('partial', route.goal);
      }
      const next = route.path[index]!;
      if (this.isOccupiedNow(next)) {
        const blocked = replan('occupied');
        if (blocked) return blocked;
        continue;
      }

      await this.deps.clock.sleep(this.tileMs);
      dir = directionTo(current, next, dir);
      current = next;
      index += 1;
      walked += 1;
      unsent += 1;

      const last = index >= route.path.length || walked >= this.maxTiles;
      if (!last && unsent < MAX_TILES_PER_REQUEST && this.deps.clock.now() < nextSendAt) {
        continue;
      }

      const sendDir = last && route.face ? directionTo(current, route.face, dir) : dir;
      const position: Position = { mapId, x: current.x, y: current.y, dir: sendDir };
      requests += 1;
      const rejected = await this.send(position);
      if (rejected === null) {
        acked = position;
        tilesMoved += unsent;
        unsent = 0;
        nextSendAt = this.deps.clock.now() + this.batchMs;
        continue;
      }

      // 409: 서버가 인정하는 위치로 되돌리고 다시 계산 (MCP.md 5.3)
      rejections += 1;
      acked = rejected.position;
      current = acked;
      dir = acked.dir;
      unsent = 0;
      nextSendAt = this.deps.clock.now() + this.batchMs;
      if (rejected.reason === 'occupied' || rejected.reason === 'collision') avoid.push(position);
      if (rejected.reason === 'not_ready') this.deps.onNotReady?.(position);
      const blocked = replan(rejected.reason);
      if (blocked) return blocked;
    }
  }

  private isOccupiedNow(tile: TilePoint): boolean {
    return this.deps.occupied().some((p) => isSameTile(p, tile));
  }

  /** 204 → null. 409 POSITION_REJECTED → 서버 인정 위치. 그 밖의 오류는 그대로 던진다 */
  private async send(position: Position): Promise<Rejected | null> {
    try {
      await this.deps.putPosition({ ...position, seq: this.deps.nextSeq() });
      this.deps.onAccepted(position);
      return null;
    } catch (error) {
      if (!(error instanceof CommuApiError) || error.code !== 'POSITION_REJECTED') throw error;
      const details = positionRejectedDetailsSchema.safeParse(error.details);
      if (!details.success) throw error;
      this.deps.onAccepted(details.data.position);
      return { reason: details.data.reason, position: details.data.position };
    }
  }
}

/** 걷기 전에 막힌 결과 (목적지 해석 실패 등). goal 은 좌표만 — Position 을 넘겨도 mapId·dir 는 버린다 (도구 출력 스키마) */
export function blockedBeforeMoving(
  from: Position,
  goal: TilePoint,
  reason: BlockedReason,
): MoveResult {
  return {
    status: 'blocked',
    reason,
    from,
    position: from,
    goal: { x: goal.x, y: goal.y },
    tilesMoved: 0,
    remainingTiles: manhattan(from, goal),
    requests: 0,
    rejections: 0,
    replans: 0,
  };
}

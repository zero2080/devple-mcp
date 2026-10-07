import { readFileSync } from 'node:fs';

import { mapGridSchema, type Direction, type MapGridData } from './schemas.js';
import { chebyshev, type TilePoint } from './world.js';

export type MapGrid = MapGridData;

export interface Hop extends TilePoint {
  dir: Direction;
}

/** 한 번의 PUT /me/position 으로 갈 수 있는 최대 거리 (API_CONTRACT 2.2: max(3, elapsedMs/100) 의 하한) */
export const MAX_HOP_DISTANCE = 3;

export function loadMapGrid(file: string): MapGrid {
  return mapGridSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function isInside(grid: MapGrid, p: TilePoint): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < grid.width && p.y < grid.height;
}

/** 맵 밖이거나 collision != 0 */
export function isBlocked(grid: MapGrid, p: TilePoint): boolean {
  if (!isInside(grid, p)) return true;
  return (grid.collision[p.y * grid.width + p.x] ?? 1) !== 0;
}

/** from 에서 to 를 바라보는 방향. 대각선이면 큰 축 우선, 같으면 세로 (프론트 domain/movement.ts 와 동일) */
export function directionTo(
  from: TilePoint,
  to: TilePoint,
  fallback: Direction = 'down',
): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

const STEPS: readonly TilePoint[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

/**
 * 4방향 BFS. 벽과 다른 접속자가 선 타일은 지나가지 않는다. 목적지만은 점유돼 있어도 허용한다
 * (PRD 5.3: 목적지에 캐릭터가 있으면 직전 타일까지 — 호출자가 마지막 칸을 잘라 낸다).
 * 결과는 from 을 제외하고 to 를 포함한 타일 열. 길이 0 이면 이미 도착, null 이면 길이 없음.
 */
export function findPath(
  grid: MapGrid,
  from: TilePoint,
  to: TilePoint,
  isOccupied: (p: TilePoint) => boolean = () => false,
): TilePoint[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (isBlocked(grid, to)) return null;

  const key = (p: TilePoint) => p.y * grid.width + p.x;
  const cameFrom = new Map<number, number>();
  const queue: TilePoint[] = [from];
  cameFrom.set(key(from), -1);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of STEPS) {
      const next = { x: current.x + step.x, y: current.y + step.y };
      const k = key(next);
      if (cameFrom.has(k) || isBlocked(grid, next)) continue;
      const isTarget = next.x === to.x && next.y === to.y;
      if (!isTarget && isOccupied(next)) continue;
      cameFrom.set(k, key(current));
      if (isTarget) {
        const path: TilePoint[] = [];
        let cursor = k;
        while (cursor !== key(from)) {
          path.push({ x: cursor % grid.width, y: Math.floor(cursor / grid.width) });
          cursor = cameFrom.get(cursor)!;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** 경로를 한 요청당 최대 maxStep 칸씩 묶는다. 각 hop 은 직전 hop 에서 체비쇼프 ≤ maxStep 이 보장된다 */
export function planHops(from: TilePoint, path: TilePoint[], maxStep = MAX_HOP_DISTANCE): Hop[] {
  const hops: Hop[] = [];
  let prev = from;
  for (let i = maxStep - 1; i < path.length; i += maxStep) {
    const tile = path[i]!;
    hops.push({ ...tile, dir: directionTo(path[i - 1] ?? prev, tile) });
    prev = tile;
  }
  const last = path[path.length - 1];
  if (
    last &&
    (hops.length === 0 ||
      hops[hops.length - 1]!.x !== last.x ||
      hops[hops.length - 1]!.y !== last.y)
  ) {
    hops.push({ ...last, dir: directionTo(path[path.length - 2] ?? prev, last) });
  }
  return hops;
}

/** 맵이 없을 때: 목적지를 향해 체비쇼프 ≤ maxStep 씩 곧장 간다 (벽은 서버 409 로 알게 된다) */
export function straightHops(from: TilePoint, to: TilePoint, maxStep = MAX_HOP_DISTANCE): Hop[] {
  const hops: Hop[] = [];
  let current = from;
  while (chebyshev(current, to) > 0) {
    const dx = Math.sign(to.x - current.x) * Math.min(maxStep, Math.abs(to.x - current.x));
    const dy = Math.sign(to.y - current.y) * Math.min(maxStep, Math.abs(to.y - current.y));
    const next = { x: current.x + dx, y: current.y + dy };
    hops.push({ ...next, dir: directionTo(current, next) });
    current = next;
  }
  return hops;
}

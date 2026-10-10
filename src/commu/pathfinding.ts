// A* 경로 탐색 (MCP.md 5.3): 4방향, 맨해튼 휴리스틱 — 프론트 src/domain/pathfinding.ts 와 같은 규칙·같은 순서
// (ARCHITECTURE 3.2.1: 벽 + 다른 캐릭터가 선 타일이 차단, 목적지가 점유돼 있으면 호출자가 직전 타일까지로 줄인다).
// 탐색은 사각형 범위(TileRect) 안에서만 한다 — 옛 맵은 맵 전체, 지상 월드는 출발·목적지 주변 (음수 좌표 가능, ground.ts)
import { mapGround, type Ground, type TileRect } from './ground.js';
import type { MapGrid } from './map.js';
import type { Direction } from './schemas.js';
import type { TilePoint } from './world.js';

/** 탐색 범위 + 판정. 범위 밖 칸은 지나가지 않는다 */
export interface PathGrid extends TileRect {
  isWall(p: TilePoint): boolean;
  isOccupied(p: TilePoint): boolean;
}

/** 프론트 movement.ts 의 DIRECTIONS 순서 — 같은 입력에 같은 경로가 나오도록 탐색 순서를 맞춘다 */
const STEPS: ReadonlyArray<{ dir: Direction; dx: number; dy: number }> = [
  { dir: 'up', dx: 0, dy: -1 },
  { dir: 'down', dx: 0, dy: 1 },
  { dir: 'left', dx: -1, dy: 0 },
  { dir: 'right', dx: 1, dy: 0 },
];

export function manhattan(a: TilePoint, b: TilePoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function isSameTile(a: TilePoint, b: TilePoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * 땅 + 탐색 범위 + 점유 타일(내 타일 제외)로 탐색 격자를 만든다. 범위 밖 점유는 보지 않는다.
 * avoid 는 서버가 409 로 알려 준 타일 — 월드가 아직 모르는 점유(occupied)나 땅 사본과 다른 벽(collision)
 */
export function createAreaPathGrid(
  ground: Ground,
  area: TileRect,
  occupied: Iterable<TilePoint>,
  avoid: Iterable<TilePoint> = [],
): PathGrid {
  const { x0, y0, width, height } = area;
  const inside = (p: TilePoint): boolean =>
    p.x >= x0 && p.y >= y0 && p.x < x0 + width && p.y < y0 + height;
  const key = (p: TilePoint) => (p.y - y0) * width + (p.x - x0);
  const taken = new Set<number>();
  for (const p of [...occupied, ...avoid]) {
    if (inside(p)) taken.add(key(p));
  }
  return {
    x0,
    y0,
    width,
    height,
    isWall: (p) => ground.isWall(p),
    isOccupied: (p) => inside(p) && taken.has(key(p)),
  };
}

/** 옛 맵 전체를 범위로 하는 탐색 격자 */
export function createPathGrid(
  map: MapGrid,
  occupied: Iterable<TilePoint>,
  avoid: Iterable<TilePoint> = [],
): PathGrid {
  const ground = mapGround(map);
  return createAreaPathGrid(
    ground,
    ground.searchArea({ x: 0, y: 0 }, { x: 0, y: 0 }),
    occupied,
    avoid,
  );
}

export interface PathSearch {
  /** 출발 타일을 제외한 순서대로의 타일. 비어 있으면 이동 없음 */
  path: TilePoint[];
  /** false 면 도달 불가 (path 는 휴리스틱상 가장 가까운 타일까지) */
  reachable: boolean;
}

interface SearchNode extends TilePoint {
  g: number;
  f: number;
  parent: SearchNode | null;
  closed: boolean;
}

/**
 * A*. from 을 제외한 경로를 돌려준다. 도달 불가면 가장 가까운 타일까지의 경로와 reachable=false.
 * allowGoalOccupied 가 true 면 목적지 타일의 점유는 무시한다 (직전 타일 처리는 호출자)
 */
export function findPath(
  grid: PathGrid,
  from: TilePoint,
  to: TilePoint,
  options: { allowGoalOccupied?: boolean; maxExpansions?: number } = {},
): PathSearch {
  if (isSameTile(from, to)) return { path: [], reachable: true };
  const { x0, y0, width, height } = grid;
  const maxExpansions = options.maxExpansions ?? width * height;
  const blocked = (p: TilePoint): boolean => {
    if (grid.isWall(p)) return true;
    if (options.allowGoalOccupied === true && isSameTile(p, to)) return false;
    return grid.isOccupied(p);
  };

  const nodes = new Map<number, SearchNode>();
  const nodeAt = (x: number, y: number): SearchNode => {
    const key = (y - y0) * width + (x - x0);
    let node = nodes.get(key);
    if (node === undefined) {
      node = { x, y, g: Infinity, f: Infinity, parent: null, closed: false };
      nodes.set(key, node);
    }
    return node;
  };

  const start = nodeAt(from.x, from.y);
  start.g = 0;
  start.f = manhattan(from, to);
  const open = new Set<SearchNode>([start]);
  let best = start;
  let bestH = start.f;
  let expansions = 0;

  while (expansions < maxExpansions) {
    let current: SearchNode | undefined;
    for (const node of open) {
      if (current === undefined || node.f < current.f) current = node;
    }
    if (current === undefined) break;
    open.delete(current);
    if (isSameTile(current, to)) return { path: reconstruct(current), reachable: true };
    current.closed = true;
    expansions += 1;
    for (const step of STEPS) {
      const next = { x: current.x + step.dx, y: current.y + step.dy };
      if (
        next.x < x0 ||
        next.y < y0 ||
        next.x >= x0 + width ||
        next.y >= y0 + height ||
        blocked(next)
      ) {
        continue;
      }
      const neighbor = nodeAt(next.x, next.y);
      if (neighbor.closed) continue;
      const tentative = current.g + 1;
      if (tentative < neighbor.g) {
        neighbor.parent = current;
        neighbor.g = tentative;
        const h = manhattan(neighbor, to);
        neighbor.f = tentative + h;
        if (h < bestH) {
          bestH = h;
          best = neighbor;
        }
        open.add(neighbor);
      }
    }
  }
  return { path: reconstruct(best), reachable: false };
}

function reconstruct(node: SearchNode): TilePoint[] {
  const path: TilePoint[] = [];
  let current = node;
  while (current.parent !== null) {
    path.push({ x: current.x, y: current.y });
    current = current.parent;
  }
  return path.reverse();
}

/**
 * around 의 주변 8칸 중 벽도 점유도 아닌 타일에서 from 에 가장 가까운(맨해튼) 것. 같으면 4방향 이웃을 먼저.
 * from 자신이 그 8칸 안이면 from (이미 옆에 있다). 없으면 null
 */
export function freeTileNear(grid: PathGrid, around: TilePoint, from: TilePoint): TilePoint | null {
  const ring: TilePoint[] = [
    ...STEPS.map((s) => ({ x: around.x + s.dx, y: around.y + s.dy })),
    { x: around.x - 1, y: around.y - 1 },
    { x: around.x + 1, y: around.y - 1 },
    { x: around.x - 1, y: around.y + 1 },
    { x: around.x + 1, y: around.y + 1 },
  ];
  let best: TilePoint | null = null;
  let bestDist = Infinity;
  for (const tile of ring) {
    if (grid.isWall(tile) || (grid.isOccupied(tile) && !isSameTile(tile, from))) continue;
    const dist = manhattan(from, tile);
    if (dist < bestDist) {
      best = tile;
      bestDist = dist;
    }
  }
  return best;
}

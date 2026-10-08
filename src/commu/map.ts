import { readFileSync } from 'node:fs';

import { mapGridSchema, type Direction, type MapGridData } from './schemas.js';
import type { TilePoint } from './world.js';

export type MapGrid = MapGridData;

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

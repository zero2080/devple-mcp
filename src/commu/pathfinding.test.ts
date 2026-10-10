import { describe, expect, it } from 'vitest';

import contractMap from './contract/maps/main.json' with { type: 'json' };
import type { MapGrid } from './map.js';
import { createPathGrid, findPath, freeTileNear, manhattan, nearestTileIn } from './pathfinding.js';
import { mapGridSchema } from './schemas.js';
import type { TilePoint } from './world.js';

function grid(width: number, height: number, walls: Array<[number, number]> = []): MapGrid {
  const collision = new Array<number>(width * height).fill(0);
  for (const [x, y] of walls) collision[y * width + x] = 1;
  return { id: 'test', width, height, spawn: { x: 0, y: 0 }, collision };
}

const openGrid = () => grid(40, 30);

function expectWalkable(path: TilePoint[], from: TilePoint): void {
  let prev = from;
  for (const tile of path) {
    expect(manhattan(prev, tile)).toBe(1);
    prev = tile;
  }
}

describe('pathfinding (A*, 프론트 ARCHITECTURE 3.2.1 과 같은 규칙)', () => {
  it('벽을 돌아가는 최단 경로를 4방향 한 칸씩 찾는다', () => {
    // x=2 열을 y=0..3 까지 막는다 (y=4 만 열림)
    const g = createPathGrid(
      grid(6, 5, [
        [2, 0],
        [2, 1],
        [2, 2],
        [2, 3],
      ]),
      [],
    );
    const { path, reachable } = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(reachable).toBe(true);
    expect(path).toHaveLength(12);
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    expect(path.some((p) => p.x === 2 && p.y === 4)).toBe(true);
    expectWalkable(path, { x: 0, y: 0 });
    expect(findPath(g, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual({ path: [], reachable: true });
  });

  it('다른 캐릭터가 선 타일은 지나지 않고, allowGoalOccupied 면 목적지만 허용한다', () => {
    const g = createPathGrid(grid(5, 1), [{ x: 2, y: 0 }]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 }).reachable).toBe(false);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }).reachable).toBe(false);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, { allowGoalOccupied: true })).toEqual({
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      reachable: true,
    });
    // 서버가 409 로 알려 준 타일(avoid)도 점유로 본다
    const avoiding = createPathGrid(grid(3, 3), [], [{ x: 1, y: 0 }]);
    const detour = findPath(avoiding, { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(detour.reachable).toBe(true);
    expect(detour.path).not.toContainEqual({ x: 1, y: 0 });
  });

  it('도달 불가면 reachable=false 와 가장 가까운 타일까지의 경로를 준다', () => {
    const g = createPathGrid(
      grid(5, 3, [
        [2, 0],
        [2, 1],
        [2, 2],
      ]),
      [],
    );
    const { path, reachable } = findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 });
    expect(reachable).toBe(false);
    expect(path[path.length - 1]).toEqual({ x: 1, y: 1 });
  });

  it('freeTileNear: 4방향 이웃 우선으로 내게 가장 가까운 빈 칸, 이미 옆이면 내 자리, 없으면 null', () => {
    const around = { x: 23, y: 15 };
    expect(freeTileNear(createPathGrid(openGrid(), []), around, { x: 20, y: 15 })).toEqual({
      x: 22,
      y: 15,
    });
    // 왼쪽이 점유되면 대각선 (22,14) 가 맨해튼 3 으로 가장 가깝다 (4방향 이웃은 거리가 같을 때만 우선)
    const leftTaken = createPathGrid(openGrid(), [{ x: 22, y: 15 }]);
    expect(freeTileNear(leftTaken, around, { x: 20, y: 15 })).toEqual({ x: 22, y: 14 });
    // 위·대각선이 같은 거리면 4방향(up) 먼저
    expect(freeTileNear(leftTaken, around, { x: 23, y: 12 })).toEqual({ x: 23, y: 14 });
    // 대각선에 이미 서 있으면 그 자리
    expect(freeTileNear(leftTaken, around, { x: 22, y: 14 })).toEqual({ x: 22, y: 14 });
    // 8칸이 전부 벽·점유
    const walls = grid(40, 30, [
      [22, 14],
      [23, 14],
      [24, 14],
      [22, 16],
      [23, 16],
      [24, 16],
    ]);
    const boxed = createPathGrid(walls, [
      { x: 22, y: 15 },
      { x: 24, y: 15 },
    ]);
    expect(freeTileNear(boxed, around, { x: 20, y: 15 })).toBeNull();
  });

  it('nearestTileIn: 장소 영역 안에서 걸어서 가장 가까운 빈 칸 — 벽은 돌아서, 안이면 제자리, 설 칸이 없으면 no_free_tile, 닿지 않으면 no_path', () => {
    // x=10 세로 벽, 맨 아래 줄(y=29)만 뚫림. 영역은 벽 서쪽 (7..9, 5..6)
    const wall = grid(
      40,
      30,
      Array.from({ length: 29 }, (_, y): [number, number] => [10, y]),
    );
    const west = { x0: 7, y0: 5, width: 3, height: 2 };
    // 직선으로는 (9,5) 가 가깝지만 벽 너머다 — 아래로 돌아 처음 닿는 (9,6)
    expect(nearestTileIn(createPathGrid(wall, []), { x: 11, y: 5 }, west)).toEqual({
      tile: { x: 9, y: 6 },
    });
    expect(nearestTileIn(createPathGrid(wall, []), { x: 8, y: 5 }, west)).toEqual({
      tile: { x: 8, y: 5 },
    });
    // 점유된 칸은 건너뛴다
    const pair = { x0: 20, y0: 20, width: 1, height: 2 };
    expect(
      nearestTileIn(createPathGrid(openGrid(), [{ x: 20, y: 20 }]), { x: 25, y: 20 }, pair),
    ).toEqual({ tile: { x: 20, y: 21 } });
    // 영역이 전부 벽
    expect(
      nearestTileIn(
        createPathGrid(wall, []),
        { x: 11, y: 5 },
        { x0: 10, y0: 0, width: 1, height: 4 },
      ),
    ).toEqual({ reason: 'no_free_tile' });
    // 빈 칸이 있지만 벽에 갇혀 있다
    const box = grid(40, 30, [
      [29, 9],
      [30, 9],
      [31, 9],
      [29, 10],
      [31, 10],
      [29, 11],
      [30, 11],
      [31, 11],
    ]);
    expect(
      nearestTileIn(
        createPathGrid(box, []),
        { x: 5, y: 5 },
        { x0: 30, y0: 10, width: 1, height: 1 },
      ),
    ).toEqual({ reason: 'no_path' });
  });

  it('계약 자산 맵: 스폰에서 열린 타일까지 길이 있고 벽은 돌아간다', () => {
    const map = mapGridSchema.parse(contractMap);
    const g = createPathGrid(map, []);
    expect(g.isWall({ x: 12, y: 15 })).toBe(true);
    expect(g.isWall({ x: 27, y: 15 })).toBe(true);
    const far = findPath(g, map.spawn, { x: 1, y: 1 });
    expect(far.reachable).toBe(true);
    expectWalkable(far.path, map.spawn);
    // (27,15) 벽을 돌아 (30,15) 로
    const detour = findPath(g, map.spawn, { x: 30, y: 15 });
    expect(detour.reachable).toBe(true);
    expect(detour.path.length).toBeGreaterThan(10);
    expect(detour.path.every((p) => !g.isWall(p))).toBe(true);
  });
});

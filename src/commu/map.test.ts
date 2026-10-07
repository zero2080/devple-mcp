import { describe, expect, it } from 'vitest';

import { directionTo, findPath, isBlocked, planHops, straightHops, type MapGrid } from './map.js';
import { chebyshev } from './world.js';

function grid(width: number, height: number, walls: Array<[number, number]> = []): MapGrid {
  const collision = new Array<number>(width * height).fill(0);
  for (const [x, y] of walls) collision[y * width + x] = 1;
  return { id: 'test', width, height, spawn: { x: 0, y: 0 }, collision };
}

describe('map', () => {
  it('벽을 돌아가는 최단 경로를 찾는다', () => {
    // x=2 열을 y=0..3 까지 막는다 (y=4 만 열림)
    const g = grid(6, 5, [
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual({ x: 4, y: 0 });
    expect(path!.some((p) => p.x === 2 && p.y === 4)).toBe(true);
    for (let i = 1; i < path!.length; i++) expect(chebyshev(path![i - 1]!, path![i]!)).toBe(1);
    expect(isBlocked(g, { x: 2, y: 1 })).toBe(true);
    expect(isBlocked(g, { x: -1, y: 0 })).toBe(true);
  });

  it('다른 캐릭터가 선 타일은 지나지 않지만 목적지로는 허용한다', () => {
    const g = grid(5, 1);
    const occupied = (p: { x: number; y: number }) => p.x === 2 && p.y === 0;
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 }, occupied)).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }, occupied)).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(findPath(g, { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([]);
    expect(findPath(grid(3, 1, [[2, 0]]), { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });

  it('planHops 는 요청당 3칸 이내로 묶고 마지막 칸을 포함한다', () => {
    const path = Array.from({ length: 7 }, (_, i) => ({ x: i + 1, y: 0 }));
    const hops = planHops({ x: 0, y: 0 }, path);
    expect(hops.map((h) => h.x)).toEqual([3, 6, 7]);
    expect(hops.every((h) => h.dir === 'right')).toBe(true);
    let prev = { x: 0, y: 0 };
    for (const hop of hops) {
      expect(chebyshev(prev, hop)).toBeLessThanOrEqual(3);
      prev = hop;
    }
    expect(planHops({ x: 0, y: 0 }, [])).toEqual([]);
  });

  it('straightHops 는 대각선으로 3칸씩 간다', () => {
    const hops = straightHops({ x: 0, y: 0 }, { x: 7, y: -2 });
    expect(hops).toEqual([
      { x: 3, y: -2, dir: 'right' },
      { x: 6, y: -2, dir: 'right' },
      { x: 7, y: -2, dir: 'right' },
    ]);
    expect(directionTo({ x: 0, y: 0 }, { x: 0, y: 3 })).toBe('down');
    expect(directionTo({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe('down');
    expect(directionTo({ x: 0, y: 0 }, { x: -3, y: 2 })).toBe('left');
  });
});

import { describe, expect, it } from 'vitest';

import { directionTo, isBlocked, isInside, type MapGrid } from './map.js';

function grid(width: number, height: number, walls: Array<[number, number]> = []): MapGrid {
  const collision = new Array<number>(width * height).fill(0);
  for (const [x, y] of walls) collision[y * width + x] = 1;
  return { id: 'test', width, height, spawn: { x: 0, y: 0 }, collision };
}

describe('map', () => {
  it('벽과 맵 밖은 막힌 타일이다', () => {
    const g = grid(3, 2, [[1, 0]]);
    expect(isBlocked(g, { x: 1, y: 0 })).toBe(true);
    expect(isBlocked(g, { x: 0, y: 0 })).toBe(false);
    expect(isBlocked(g, { x: -1, y: 0 })).toBe(true);
    expect(isBlocked(g, { x: 3, y: 1 })).toBe(true);
    expect(isInside(g, { x: 2, y: 1 })).toBe(true);
    expect(isInside(g, { x: 2, y: 2 })).toBe(false);
  });

  it('directionTo: 큰 축 우선, 같으면 세로, 같은 타일이면 fallback (프론트 movement.ts)', () => {
    expect(directionTo({ x: 0, y: 0 }, { x: 0, y: 3 })).toBe('down');
    expect(directionTo({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe('up');
    expect(directionTo({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe('down');
    expect(directionTo({ x: 0, y: 0 }, { x: -3, y: 2 })).toBe('left');
    expect(directionTo({ x: 0, y: 0 }, { x: 3, y: -2 })).toBe('right');
    expect(directionTo({ x: 1, y: 1 }, { x: 1, y: 1 }, 'left')).toBe('left');
  });
});

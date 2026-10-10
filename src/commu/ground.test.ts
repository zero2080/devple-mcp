import { describe, expect, it } from 'vitest';

import contractTerrain from './contract/world/terrain.json' with { type: 'json' };
import {
  ChunkCache,
  chunkGround,
  chunkOf,
  loadTerrainRules,
  mapGround,
  TERRAIN_VERSION,
  TILE_LIMIT,
  type TerrainRules,
} from './ground.js';
import type { WorldChunk } from './schemas.js';

const rules: TerrainRules = { chunkSize: 4, pass: { '.': 'walk', '~': 'water', H: 'block' } };

function chunk(
  cx: number,
  cy: number,
  rows = ['....', '.~..', '..H.', '....'],
  version = 1,
): WorldChunk {
  return {
    cx,
    cy,
    rows,
    places: [{ name: '광장', x: cx * 4, y: cy * 4, w: 2, h: 2 }],
    concept: 'test',
    version,
  };
}

describe('지형 규칙 (계약 자산 world/terrain.json)', () => {
  it('계약 자산은 2판·chunkSize 32 — 지형 문자를 통행으로 읽는다', () => {
    const terrain = loadTerrainRules(contractTerrain);
    expect(terrain.chunkSize).toBe(32);
    expect(terrain.pass['.']).toBe('walk');
    expect(terrain.pass['~']).toBe('water');
    expect(terrain.pass.H).toBe('block');
  });

  it('다른 판이면 읽지 않는다 (잘못 동기화된 사본)', () => {
    expect(() => loadTerrainRules({ ...contractTerrain, version: TERRAIN_VERSION - 1 })).toThrow(
      /2판/,
    );
  });
});

describe('ChunkCache · chunkGround (MCP.md 3.2·5.3)', () => {
  it('chunkOf 는 내림 나눗셈 — 타일 −1 은 청크 −1', () => {
    expect(chunkOf(-1, 0, 4)).toEqual({ cx: -1, cy: 0 });
    expect(chunkOf(4, -5, 4)).toEqual({ cx: 1, cy: -2 });
  });

  it('받아 둔 청크의 walk 칸만 땅 — 물·막힘·받지 않은 청크·좌표 범위 밖은 벽, 벽의 이유를 구분한다', () => {
    const cache = new ChunkCache();
    cache.applyFetched([chunk(-1, 0)], [{ cx: 0, cy: 0 }], 0);
    const ground = chunkGround(cache, rules, 2);
    expect(ground.isWall({ x: -4, y: 0 })).toBe(false);
    expect(ground.isWall({ x: -3, y: 1 })).toBe(true); // 물
    expect(ground.wallReason({ x: -3, y: 1 })).toBe('collision');
    expect(ground.isWall({ x: 0, y: 0 })).toBe(true); // 준비 중
    expect(ground.wallReason({ x: 0, y: 0 })).toBe('not_ready');
    expect(ground.wallReason({ x: TILE_LIMIT + 1, y: 0 })).toBe('collision');
    expect(ground.searchArea({ x: -4, y: 0 }, { x: -1, y: 3 })).toEqual({
      x0: -6,
      y0: -2,
      width: 8,
      height: 8,
    });
  });

  it('world.chunk 는 version 이 같거나 높을 때만 바꾸고, 준비 중 표시를 지운다', () => {
    const cache = new ChunkCache();
    cache.applyFetched([chunk(0, 0, undefined, 2)], [{ cx: 1, cy: 0 }], 1_000);
    expect(cache.isFreshPending({ cx: 1, cy: 0 }, 5_999, 5_000)).toBe(true);
    expect(cache.isFreshPending({ cx: 1, cy: 0 }, 6_000, 5_000)).toBe(false);
    cache.applyChunk(chunk(0, 0, ['~~~~', '~~~~', '~~~~', '~~~~'], 1));
    expect(cache.isWalk(rules, { x: 0, y: 0 })).toBe(true); // 옛 판은 무시
    cache.applyChunk(chunk(1, 0));
    expect(cache.isFreshPending({ cx: 1, cy: 0 }, 1_000, 5_000)).toBe(false);
    expect(cache.isWalk(rules, { x: 4, y: 0 })).toBe(true);
  });

  it('forget·prune·clear — 멀어진 청크와 준비 중 표시를 버린다, 장소는 그 청크에서 찾는다', () => {
    const cache = new ChunkCache();
    cache.applyFetched([chunk(0, 0), chunk(3, 0), chunk(-4, -4)], [{ cx: 5, cy: 0 }], 0);
    expect(cache.placeAt(rules, { x: 1, y: 1 })?.name).toBe('광장');
    expect(cache.placeAt(rules, { x: 2, y: 2 })).toBeUndefined();
    cache.prune({ cx: 0, cy: 0 }, 3);
    expect(cache.get(3, 0)).toBeDefined();
    expect(cache.get(-4, -4)).toBeUndefined();
    expect(cache.isFreshPending({ cx: 5, cy: 0 }, 0, 5_000)).toBe(false);
    cache.forget({ cx: 0, cy: 0 });
    expect(cache.get(0, 0)).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('옛 맵 땅: collision·맵 밖은 벽(collision), 탐색 범위는 맵 전체', () => {
    const map = {
      id: 'main',
      width: 3,
      height: 2,
      spawn: { x: 0, y: 0 },
      collision: [0, 1, 0, 0, 0, 0],
    };
    const ground = mapGround(map);
    expect(ground.isWall({ x: 1, y: 0 })).toBe(true);
    expect(ground.isWall({ x: -1, y: 0 })).toBe(true);
    expect(ground.isWall({ x: 2, y: 1 })).toBe(false);
    expect(ground.wallReason({ x: 1, y: 0 })).toBe('collision');
    expect(ground.searchArea({ x: 0, y: 0 }, { x: 2, y: 1 })).toEqual({
      x0: 0,
      y0: 0,
      width: 3,
      height: 2,
    });
  });
});

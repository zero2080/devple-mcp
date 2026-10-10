// 캐릭터가 걷는 땅 (MCP.md 5.3, DOMAIN 4.3 옛 맵 · 4.4 지상 월드) — 프론트 src/domain/ground.ts·chunk.ts 포팅.
// 경로 탐색·이동은 옛 맵인지 지상 월드인지 모르고 Ground 만 읽는다. 지상 월드는 받아 둔 청크의 walk 칸만 땅이고,
// 준비되지 않았거나 받지 않은 청크는 벽이다 (AI 의 이동은 청크 생성을 일으키지 않는다 — DOMAIN 4.6).
import { isBlocked, type MapGrid } from './map.js';
import {
  terrainAssetSchema,
  type ChunkCoord,
  type Place,
  type TerrainPass,
  type WorldChunk,
} from './schemas.js';
import type { TilePoint } from './world.js';

/** 타일 사각형. (x0, y0) 이 왼쪽 위, 크기는 칸 수 */
export interface TileRect {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

export interface Ground {
  /** 설 수 없는 칸: 벽·물·맵 밖, 지상 월드는 준비되지 않은(받지 않은) 청크도 */
  isWall(p: TilePoint): boolean;
  /** from → to 경로 탐색이 볼 범위. 밖은 벽으로 본다 */
  searchArea(from: TilePoint, to: TilePoint): TileRect;
  /** 벽인 칸의 이유: 지형(collision) 또는 아직 받지 않은·준비되지 않은 청크(not_ready) */
  wallReason(p: TilePoint): 'collision' | 'not_ready';
}

/** 옛 맵: collision 과 맵 경계. 탐색 범위는 맵 전체 */
export function mapGround(map: MapGrid): Ground {
  const area: TileRect = { x0: 0, y0: 0, width: map.width, height: map.height };
  return {
    isWall: (p) => isBlocked(map, p),
    searchArea: () => area,
    wallReason: () => 'collision',
  };
}

/** DOMAIN 4.1: 지상 월드 타일은 원점에서 두 축 모두 이 거리 안 */
export const TILE_LIMIT = 1_000_000;

/**
 * 지상 월드 탐색 여유 (타일). 끝이 없는 땅이라 출발·목적지를 감싼 사각형에 이만큼만 더 본다 —
 * 돌아가는 길은 찾고, 갈 수 없는 목적지가 받아 둔 청크 전체를 뒤지지 않게 (프론트 GROUND_SEARCH_MARGIN)
 */
export const GROUND_SEARCH_MARGIN = 32;

/** 계약 자산 world/terrain.json 에서 경로 계산이 쓰는 부분 */
export interface TerrainRules {
  chunkSize: number;
  pass: Readonly<Record<string, TerrainPass>>;
}

/** 지형 자산 판 (DOMAIN 3.2 — 서버 ContractAssets.TERRAIN_VERSION 과 같다). 다르면 잘못 동기화된 사본 */
export const TERRAIN_VERSION = 2;

export function loadTerrainRules(asset: unknown): TerrainRules {
  const parsed = terrainAssetSchema.parse(asset);
  if (parsed.version !== TERRAIN_VERSION) {
    throw new Error(
      `지형 자산 ${String(parsed.version)}판 — ${String(TERRAIN_VERSION)}판이어야 한다`,
    );
  }
  return {
    chunkSize: parsed.chunkSize,
    pass: Object.fromEntries(Object.entries(parsed.terrain).map(([c, t]) => [c, t.pass])),
  };
}

/** (x, y) 가 속한 청크 — 내림 나눗셈이라 x = -1 은 청크 -1 (DOMAIN 4.4) */
export function chunkOf(x: number, y: number, size: number): ChunkCoord {
  return { cx: Math.floor(x / size), cy: Math.floor(y / size) };
}

export function chunkKey(cx: number, cy: number): string {
  return `${String(cx)},${String(cy)}`;
}

/** 두 청크 사이 체비쇼프 거리 */
export function chunkDistance(a: ChunkCoord, b: ChunkCoord): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy));
}

/** p 에서 장소 영역의 가장 가까운 칸까지 체비쇼프 거리 (안이면 0) */
export function placeDistance(p: TilePoint, place: Place): number {
  const dx = Math.max(place.x - p.x, 0, p.x - (place.x + place.w - 1));
  const dy = Math.max(place.y - p.y, 0, p.y - (place.y + place.h - 1));
  return Math.max(dx, dy);
}

/** 내가 있는 곳 (MCP.md 5.1 commu_look_around area): 구역 컨셉과, 장소 안이면 그 이름 */
export interface Area {
  concept: string;
  place?: string;
}

/** 근처 장소 (MCP.md 5.1 places): 이름·영역·거리 */
export interface PlaceNearby extends Place {
  distance: number;
}

/**
 * 받아 둔 지상 월드 청크 (MCP.md 3.2: 세션 동안 캐시, world.chunk 가 오면 바꾼다). 준비 중(pending) 청크는
 * 언제 조회했는지만 둔다 — 다시 물을지 정할 때 쓴다
 */
export class ChunkCache {
  private readonly chunks = new Map<string, WorldChunk>();
  private readonly pendingAt = new Map<string, number>();

  get size(): number {
    return this.chunks.size;
  }

  get(cx: number, cy: number): WorldChunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  /** 조회 결과: 준비된 청크는 넣고(옛 판이면 무시), 준비 중은 시각을 적는다 */
  applyFetched(chunks: readonly WorldChunk[], pending: readonly ChunkCoord[], now: number): void {
    for (const chunk of chunks) this.applyChunk(chunk);
    for (const c of pending) {
      const key = chunkKey(c.cx, c.cy);
      if (!this.chunks.has(key)) this.pendingAt.set(key, now);
    }
  }

  /** world.chunk: 같은 청크는 version 이 같거나 높을 때만 (늦게 온 옛 조회 결과가 덮지 않게) */
  applyChunk(chunk: WorldChunk): void {
    const key = chunkKey(chunk.cx, chunk.cy);
    const current = this.chunks.get(key);
    if (current !== undefined && current.version > chunk.version) return;
    this.chunks.set(key, chunk);
    this.pendingAt.delete(key);
  }

  /** 준비 중으로 알고 있고 그 뒤로 maxAgeMs 가 지나지 않았으면 true (다시 묻지 않는다) */
  isFreshPending(c: ChunkCoord, now: number, maxAgeMs: number): boolean {
    const at = this.pendingAt.get(chunkKey(c.cx, c.cy));
    return at !== undefined && now - at < maxAgeMs;
  }

  /** 서버가 not_ready 로 거부한 청크: 받아 둔 것을 버린다 (다시 받을 때까지 벽) */
  forget(c: ChunkCoord): void {
    this.chunks.delete(chunkKey(c.cx, c.cy));
  }

  /** center 에서 체비쇼프 거리 keep 보다 먼 청크·준비 중 표시를 버린다 (멀리 걸어가도 메모리가 늘지 않게) */
  prune(center: ChunkCoord, keep: number): void {
    for (const map of [this.chunks, this.pendingAt] as Map<string, unknown>[]) {
      for (const key of map.keys()) {
        const [cx = 0, cy = 0] = key.split(',').map(Number);
        if (chunkDistance(center, { cx, cy }) > keep) map.delete(key);
      }
    }
  }

  clear(): void {
    this.chunks.clear();
    this.pendingAt.clear();
  }

  /** 그 칸이 걸을 수 있는 땅인지: 받아 둔 청크의 walk 칸만 (좌표 범위 밖·받지 않은 청크는 아니다) */
  isWalk(rules: TerrainRules, p: TilePoint): boolean {
    if (Math.abs(p.x) > TILE_LIMIT || Math.abs(p.y) > TILE_LIMIT) return false;
    const { cx, cy } = chunkOf(p.x, p.y, rules.chunkSize);
    const chunk = this.get(cx, cy);
    const c = chunk?.rows[p.y - cy * rules.chunkSize]?.[p.x - cx * rules.chunkSize];
    return c !== undefined && rules.pass[c] === 'walk';
  }

  /** (x, y) 를 덮는 장소 (장소는 자기 청크 밖으로 나가지 않는다 — DOMAIN 4.5). 겹치면 먼저 적힌 것 */
  placeAt(rules: TerrainRules, p: TilePoint): Place | undefined {
    const { cx, cy } = chunkOf(p.x, p.y, rules.chunkSize);
    return this.get(cx, cy)?.places.find(
      (pl) => p.x >= pl.x && p.y >= pl.y && p.x < pl.x + pl.w && p.y < pl.y + pl.h,
    );
  }

  /** p 가 있는 구역: 그 청크의 컨셉과 p 를 덮는 장소 이름. 청크를 받지 않았으면 undefined */
  areaAt(rules: TerrainRules, p: TilePoint): Area | undefined {
    const { cx, cy } = chunkOf(p.x, p.y, rules.chunkSize);
    const chunk = this.get(cx, cy);
    if (!chunk) return undefined;
    const place = this.placeAt(rules, p);
    return { concept: chunk.concept, ...(place ? { place: place.name } : {}) };
  }

  /**
   * 시야 안(p 의 청크에서 청크 거리 radius 이내) 받아 둔 청크의 장소를 가까운 순으로 — 거리가 같으면 북서쪽 청크·먼저 적힌 것.
   * 같은 이름이 여럿이면 모두 (move_to { place } 는 가장 가까운 것으로 간다)
   */
  placesNear(rules: TerrainRules, p: TilePoint, radius: number): PlaceNearby[] {
    const center = chunkOf(p.x, p.y, rules.chunkSize);
    const found: PlaceNearby[] = [];
    for (let cy = center.cy - radius; cy <= center.cy + radius; cy += 1) {
      for (let cx = center.cx - radius; cx <= center.cx + radius; cx += 1) {
        for (const place of this.get(cx, cy)?.places ?? []) {
          found.push({ ...place, distance: placeDistance(p, place) });
        }
      }
    }
    // Array.prototype.sort 는 안정 정렬이라 같은 거리는 위에서 넣은 순서(북서쪽부터)를 지킨다
    return found.sort((a, b) => a.distance - b.distance);
  }
}

/** 지상 월드: 받아 둔 청크의 walk 칸만 지나간다 */
export function chunkGround(
  cache: ChunkCache,
  rules: TerrainRules,
  margin: number = GROUND_SEARCH_MARGIN,
): Ground {
  return {
    isWall: (p) => !cache.isWalk(rules, p),
    wallReason: (p) => {
      const { cx, cy } = chunkOf(p.x, p.y, rules.chunkSize);
      const inWorld = Math.abs(p.x) <= TILE_LIMIT && Math.abs(p.y) <= TILE_LIMIT;
      return inWorld && cache.get(cx, cy) === undefined ? 'not_ready' : 'collision';
    },
    searchArea: (from, to) => {
      const x0 = Math.min(from.x, to.x) - margin;
      const y0 = Math.min(from.y, to.y) - margin;
      return {
        x0,
        y0,
        width: Math.max(from.x, to.x) + margin - x0 + 1,
        height: Math.max(from.y, to.y) + margin - y0 + 1,
      };
    },
  };
}

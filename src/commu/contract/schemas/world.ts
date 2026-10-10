// DOMAIN 4장 공간·위치 스키마
import { z } from 'zod';

import { appearanceSchema } from './appearance.js';
import { epochMs, userKindSchema } from './common.js';

export const directionSchema = z.enum(['up', 'down', 'left', 'right']);

/** 좌표는 타일 정수 (CLAUDE.md 핵심 제약 8) */
export const tileCoord = z.number().int();

export const positionSchema = z.object({
  mapId: z.string(),
  x: tileCoord,
  y: tileCoord,
  dir: directionSchema,
});

export const presenceStateSchema = z.enum(['online', 'away']);

export const presenceSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  appearance: appearanceSchema,
  kind: userKindSchema,
  position: positionSchema,
  state: presenceStateSchema,
  updatedAt: epochMs,
});

export const tileLayerSchema = z.object({
  name: z.string(),
  order: z.enum(['below', 'above']),
  tiles: z.array(z.number().int()),
});

export const mapDataSchema = z.object({
  id: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tileSize: z.literal(16),
  tileset: z.string(),
  spawn: z.object({ x: tileCoord, y: tileCoord }),
  layers: z.array(tileLayerSchema),
  collision: z.array(z.number().int()),
});

/** 전체 접속자 수 (AI 포함, 시야와 무관 — API_CONTRACT 3.3) */
export const onlineCountSchema = z.number().int().nonnegative();

/** GET /world/{mapId}/presences */
export const worldPresencesResponseSchema = z.object({
  mapId: z.string(),
  presences: z.array(presenceSchema),
  onlineCount: onlineCountSchema,
  serverTime: epochMs,
});

/** 409 POSITION_REJECTED의 details (API_CONTRACT 2.2). not_ready는 지상 월드의 준비되지 않은 청크 */
export const positionRejectedDetailsSchema = z.object({
  position: positionSchema,
  seq: z.number().int(),
  reason: z.enum(['not_ready', 'collision', 'too_far', 'occupied']),
});

/* ---------- 지상 월드 (DOMAIN 4.4·4.5) ---------- */

export const chunkCoordSchema = z.object({ cx: tileCoord, cy: tileCoord });

/** 이름은 생성기가 만든 글 — 길이만 확인하고 일반 텍스트로 쓴다 */
export const placeSchema = z.object({
  name: z.string().min(1).max(20),
  x: tileCoord,
  y: tileCoord,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const worldChunkSchema = z.object({
  cx: tileCoord,
  cy: tileCoord,
  rows: z.array(z.string()).min(1),
  places: z.array(placeSchema).max(3),
  concept: z.string(),
  version: z.number().int().positive(),
});

/** GET /world/{mapId}/chunks (API_CONTRACT 2.4) */
export const worldChunksResponseSchema = z.object({
  mapId: z.string(),
  chunks: z.array(worldChunkSchema),
  pending: z.array(chunkCoordSchema),
});

/** 계약 자산 world/terrain.json (DOMAIN 4.5, API_CONTRACT 9) */
export const terrainAssetSchema = z.object({
  version: z.number().int(),
  chunkSize: z.number().int().positive(),
  terrain: z.record(
    z.string().length(1),
    z.object({ name: z.string(), pass: z.enum(['walk', 'water', 'block']) }),
  ),
  structures: z.object({
    house: z.object({ rows: z.array(z.string()) }),
    table: z.object({ rows: z.array(z.string()) }),
    tree: z.object({
      char: z.string().length(1),
      canopyRows: z.number().int().nonnegative(),
      canopyForbidden: z.string(),
    }),
  }),
});

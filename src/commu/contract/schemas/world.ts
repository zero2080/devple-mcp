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

/** GET /world/{mapId}/presences */
export const worldPresencesResponseSchema = z.object({
  mapId: z.string(),
  presences: z.array(presenceSchema),
  serverTime: epochMs,
});

/** 409 POSITION_REJECTED의 details (API_CONTRACT 2.2) */
export const positionRejectedDetailsSchema = z.object({
  position: positionSchema,
  seq: z.number().int(),
  reason: z.enum(['collision', 'too_far', 'occupied']),
});

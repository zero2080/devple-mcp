// API_CONTRACT 3.2 이벤트 봉투와 3.3 payload 스키마 (이벤트 16종)
import { z } from 'zod';

import { appearanceSchema } from './appearance.js';
import { epochMs } from './common.js';
import {
  chatDmEventSchema,
  chatGroupEventSchema,
  chatPublicEventSchema,
  groupSchema,
  groupUpdatedEventSchema,
  noticeSchema,
} from './message.js';
import { directionSchema, presenceSchema, presenceStateSchema, tileCoord } from './world.js';

export const SSE_EVENT_TYPES = [
  'world.snapshot',
  'world.positions',
  'presence.joined',
  'presence.left',
  'presence.updated',
  'chat.public',
  'chat.dm',
  'chat.dm.recalled',
  'chat.dm.read',
  'chat.group',
  'group.joined',
  'group.updated',
  'group.removed',
  'system.notice',
  'system.suspended',
  'system.heartbeat',
  'sync.required',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export const sseEventTypeSchema = z.enum(SSE_EVENT_TYPES);

/** 봉투. payload는 type별 스키마로 2차 파싱한다 (registry) */
export const sseEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  ts: epochMs,
  payload: z.unknown(),
});

export type SseEnvelope = z.infer<typeof sseEnvelopeSchema>;

export const worldSnapshotPayloadSchema = z.object({
  mapId: z.string(),
  presences: z.array(presenceSchema),
  serverTime: epochMs,
});

export const worldPositionsPayloadSchema = z.object({
  mapId: z.string(),
  positions: z.array(
    z.object({
      userId: z.string(),
      x: tileCoord,
      y: tileCoord,
      dir: directionSchema,
    }),
  ),
});

export const presenceJoinedPayloadSchema = presenceSchema;

export const presenceLeftPayloadSchema = z.object({ userId: z.string() });

export const presenceUpdatedPayloadSchema = z.object({
  userId: z.string(),
  state: presenceStateSchema.optional(),
  nickname: z.string().optional(),
  appearance: appearanceSchema.optional(), // 바뀔 때 전체 (API_CONTRACT 3.3)
});

export const chatPublicPayloadSchema = chatPublicEventSchema;
export const chatDmPayloadSchema = chatDmEventSchema;

export const chatDmRecalledPayloadSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
});

export const chatDmReadPayloadSchema = z.object({
  conversationId: z.string(),
  readerId: z.string(),
  lastMessageId: z.string(),
  readAt: epochMs,
});

export const chatGroupPayloadSchema = chatGroupEventSchema;
export const groupJoinedPayloadSchema = groupSchema;
export const groupUpdatedPayloadSchema = groupUpdatedEventSchema;

export const groupRemovedPayloadSchema = z.object({
  groupId: z.string(),
  reason: z.enum(['kicked', 'dissolved', 'left']), // left: 나간 본인의 다른 탭 동기화 (API_CONTRACT 1.5)
});

export const systemNoticePayloadSchema = noticeSchema;
export const systemSuspendedPayloadSchema = z.object({});

/** 15초 간격 생존 신호 (API_CONTRACT 3.1). 재전송 버퍼 제외 */
export const systemHeartbeatPayloadSchema = z.object({ serverTime: epochMs });

export const syncRequiredPayloadSchema = z.object({
  reason: z.enum(['buffer_overflow', 'server_restart']),
});

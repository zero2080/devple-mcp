// 계약 스키마의 원천은 src/commu/contract/ (프론트 저장소에서 scripts/sync-commu-contract.sh 로 복사, 손 편집 금지).
// 이 파일은 그 재export 와 MCP 전용 스키마·타입 별칭만 둔다.
import { z } from 'zod';

import { authSessionSchema, tileCoord } from './contract/schemas/index.js';
import type {
  appearanceSchema,
  meSchema,
  directionSchema,
  dmConversationWithPeerSchema,
  dmMessageSchema,
  groupDetailSchema,
  groupListItemSchema,
  groupMemberSchema,
  groupMemberWithUserSchema,
  groupMessageSchema,
  groupSchema,
  noticeSchema,
  positionRejectedDetailsSchema,
  positionSchema,
  presenceSchema,
  presenceStateSchema,
  presenceUpdatedPayloadSchema,
  publicMessageSchema,
  serverConfigSchema,
  userProfileSchema,
  userSchema,
  worldPositionsPayloadSchema,
  worldPresencesResponseSchema,
  worldSnapshotPayloadSchema,
} from './contract/schemas/index.js';

export * from './contract/schemas/index.js';

/** 맵 자산 중 서버·MCP 가 쓰는 부분 (DOMAIN 4.3, API_CONTRACT 9). 레이어·타일셋은 렌더 전용이라 뺀다 */
export const mapGridSchema = z.object({
  id: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  spawn: z.object({ x: tileCoord, y: tileCoord }),
  collision: z.array(z.number().int()),
});

/** POST /auth/ai-token 응답 (API_CONTRACT 2.9) — 로그인 응답과 같은 모양, 쿠키만 없다 */
export const aiTokenExchangeResponseSchema = authSessionSchema;

/* ---------- 런타임 스키마에서 유도한 타입 별칭 ---------- */

export type Appearance = z.infer<typeof appearanceSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type Position = z.infer<typeof positionSchema>;
export type PositionRejectedReason = z.infer<typeof positionRejectedDetailsSchema>['reason'];
export type Presence = z.infer<typeof presenceSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type MapGridData = z.infer<typeof mapGridSchema>;
export type WorldPresencesResponse = z.infer<typeof worldPresencesResponseSchema>;
export type User = z.infer<typeof userSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type Me = z.infer<typeof meSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type AuthSession = z.infer<typeof aiTokenExchangeResponseSchema>;
export type PublicMessage = z.infer<typeof publicMessageSchema>;
export type DmMessage = z.infer<typeof dmMessageSchema>;
export type DmConversationWithPeer = z.infer<typeof dmConversationWithPeerSchema>;
export type Group = z.infer<typeof groupSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupMessage = z.infer<typeof groupMessageSchema>;
export type GroupListItem = z.infer<typeof groupListItemSchema>;
export type GroupDetail = z.infer<typeof groupDetailSchema>;
export type GroupMemberWithUser = z.infer<typeof groupMemberWithUserSchema>;
export type Notice = z.infer<typeof noticeSchema>;
export type WorldSnapshotPayload = z.infer<typeof worldSnapshotPayloadSchema>;
export type WorldPositionsPayload = z.infer<typeof worldPositionsPayloadSchema>;
export type PresenceUpdatedPayload = z.infer<typeof presenceUpdatedPayloadSchema>;

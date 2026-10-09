// DOMAIN 3.5·3.6, API_CONTRACT 2.1 인증 응답 스키마
import { z } from 'zod';

import { avatarOptionsSchema } from './appearance.js';
import { meSchema, signupStatusSchema } from './user.js';

export const serverConfigSchema = z.object({
  proximityRadius: z.number().int().nonnegative(),
  positionBatchMs: z.number().int().positive(),
  serverTickMs: z.number().int().positive(),
  maxMessageLength: z.number().int().positive(),
  defaultMapId: z.string(),
  maxGroupMembers: z.number().int().positive(),
  avatarOptions: avatarOptionsSchema,
  // DOMAIN 2.7 3.6. 서버 2.9 배포 전에는 안 오므로 기본 2 (하위 호환 — 서버가 보내면 그 값)
  maxAiPerMember: z.number().int().positive(),
  maxTokensPerAi: z.number().int().positive(),
});

export const authSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  me: meSchema,
  config: serverConfigSchema,
});

/** POST /auth/refresh */
export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
});

/** POST /signup → 201 */
export const signupResponseSchema = z.object({
  requestId: z.string(),
  status: signupStatusSchema,
});

/** GET /signup/{requestId} */
export const signupStatusResponseSchema = z.object({
  status: signupStatusSchema,
  rejectReason: z.string().optional(),
});

/** POST /sse/ticket → 201 */
export const sseTicketResponseSchema = z.object({
  ticket: z.string(),
  expiresIn: z.number().int().positive(),
});

/** GET /me */
export const meResponseSchema = z.object({
  me: meSchema,
  config: serverConfigSchema,
});

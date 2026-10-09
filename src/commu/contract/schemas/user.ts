// DOMAIN 3장 사용자 스키마
import { z } from 'zod';

import { appearanceSchema } from './appearance.js';
import { epochMs, userKindSchema } from './common.js';
import { positionSchema } from './world.js';

export const userRoleSchema = z.enum(['member', 'admin']);
export const userStatusSchema = z.enum(['active', 'suspended']);

export const userSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  appearance: appearanceSchema,
  statusMessage: z.string().optional(),
  kind: userKindSchema,
  ownerId: z.string().optional(), // kind='ai'일 때만
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: epochMs,
});

export const userProfileSchema = z.object({
  user: userSchema,
  online: z.boolean(),
  position: positionSchema.optional(),
});

export const meSchema = userSchema.extend({
  email: z.string().optional(), // AI는 없다 (DOMAIN 2.7 3.3)
  phone: z.string().optional(),
  nicknameChangeableAt: epochMs.optional(), // API_CONTRACT 2.8: 바꿀 수 있으면 키 없음
});

/** DOMAIN 3.8 AI 계정 */
export const aiTokenInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  createdAt: epochMs,
  lastUsedAt: epochMs.optional(),
});

/** POST /me/ai/{aiId}/tokens → 201. token은 이 응답에서 한 번만 */
export const aiTokenIssuedSchema = aiTokenInfoSchema.extend({ token: z.string() });

/** GET /me/ai 항목 */
export const myAiSchema = userSchema.extend({
  tokens: z.array(aiTokenInfoSchema),
  online: z.boolean(),
});

/** GET /me/ai */
export const myAiListResponseSchema = z.object({ items: z.array(myAiSchema) });

export const signupStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export const signupRequestSchema = z.object({
  id: z.string(),
  email: z.string(),
  nickname: z.string(),
  phone: z.string(),
  status: signupStatusSchema,
  rejectReason: z.string().optional(),
  createdAt: epochMs,
  reviewedAt: epochMs.optional(),
  reviewedBy: z.string().optional(),
});

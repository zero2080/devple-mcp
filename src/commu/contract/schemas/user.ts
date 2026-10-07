// DOMAIN 3장 사용자 스키마
import { z } from 'zod';

import { appearanceSchema } from './appearance.js';
import { epochMs } from './common.js';
import { positionSchema } from './world.js';

export const userRoleSchema = z.enum(['member', 'admin']);
export const userStatusSchema = z.enum(['active', 'suspended']);

export const userSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  appearance: appearanceSchema,
  statusMessage: z.string().optional(),
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
  email: z.string(),
  phone: z.string(),
  nicknameChangeableAt: epochMs.optional(), // API_CONTRACT 2.8: 바꿀 수 있으면 키 없음
});

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

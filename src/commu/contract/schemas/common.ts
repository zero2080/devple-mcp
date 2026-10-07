// 공통 스키마: 페이지네이션, 에러 본문 (API_CONTRACT 1.1·1.3)
import { z } from 'zod';

/** 목록 응답 `{ items, nextCursor }` */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'MESSAGE_INVALID_CONTENT',
  'AUTH_REQUIRED',
  'AUTH_INVALID_KEY',
  'USER_SUSPENDED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NICKNAME_TAKEN',
  'NICKNAME_COOLDOWN',
  'SIGNUP_ALREADY_REVIEWED',
  'GROUP_FULL',
  'POSITION_REJECTED',
  'MESSAGE_ALREADY_READ',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Unix epoch ms (DOMAIN 1장). 음수·소수는 없다 */
export const epochMs = z.number().int().nonnegative();

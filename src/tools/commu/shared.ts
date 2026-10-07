import type { CallToolResult } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';

import { CommuApiError, describeApiError } from '../../commu/errors.js';
import {
  userKindSchema,
  userRoleSchema,
  userStatusSchema,
  type User,
} from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { toolResult } from '../../commu/untrusted.js';
import { log } from '../../logger.js';

/* ---------- 결과 포장 ---------- */

export function toolError(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
}

/**
 * 도구 본문을 감싼다: 유휴 타이머 리셋(MCP.md 3.3), 예외 → isError 결과(MCP.md 7).
 * LLM 이 에러 코드·details 를 읽고 대응할 수 있게 계약 형식을 그대로 싣는다.
 * 결과에 untrusted 가 있으면 텍스트 맨 앞에 고정 안내가 붙는다 (MCP.md 6.1, toolResult).
 */
export async function runTool<T extends object>(
  session: CommuSession,
  fn: () => Promise<T>,
): Promise<CallToolResult> {
  session.touch();
  try {
    return toolResult(await fn());
  } catch (error) {
    log.debug('tool failed', error);
    return toolError(error);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof CommuApiError) return describeApiError(error);
  if (error instanceof ZodError) {
    return `응답 형식이 계약과 달라요: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ---------- LLM 에게 보여 줄 간결한 형태 (외형 appearance 등은 뺀다) ---------- */

export const compactUserSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  kind: userKindSchema,
  ownerId: z.string().optional(),
  statusMessage: z.string().optional(),
  role: userRoleSchema,
  status: userStatusSchema,
});
export type CompactUser = z.infer<typeof compactUserSchema>;

export function compactUser(user: User): CompactUser {
  return {
    id: user.id,
    nickname: user.nickname,
    kind: user.kind,
    ...(user.ownerId !== undefined ? { ownerId: user.ownerId } : {}),
    ...(user.statusMessage !== undefined ? { statusMessage: user.statusMessage } : {}),
    role: user.role,
    status: user.status,
  };
}

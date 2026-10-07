import type { CallToolResult } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';

import { CommuApiError, describeApiError } from '../../commu/errors.js';
import {
  directionSchema,
  epochMs,
  positionSchema,
  presenceStateSchema,
  userKindSchema,
  userRoleSchema,
  userStatusSchema,
  type DmMessage,
  type GroupMemberWithUser,
  type GroupMessage,
  type Presence,
  type PublicMessage,
  type User,
} from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { log } from '../../logger.js';

/* ---------- 결과 포장 ---------- */

export function toolOk(output: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output as unknown as Record<string, unknown>,
  };
}

export function toolError(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
}

/**
 * 도구 본문을 감싼다: 유휴 타이머 리셋(MCP.md 3.3), 예외 → isError 결과(MCP.md 7).
 * LLM 이 에러 코드·details 를 읽고 대응할 수 있게 계약 형식을 그대로 싣는다.
 */
export async function runTool<T extends object>(
  session: CommuSession,
  fn: () => Promise<T>,
): Promise<CallToolResult> {
  session.touch();
  try {
    return toolOk(await fn());
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

export const compactPresenceSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  kind: userKindSchema,
  x: z.number().int(),
  y: z.number().int(),
  dir: directionSchema,
  state: presenceStateSchema,
});

export function compactPresence(p: Presence) {
  return {
    userId: p.userId,
    nickname: p.nickname,
    kind: p.kind,
    x: p.position.x,
    y: p.position.y,
    dir: p.position.dir,
    state: p.state,
  };
}

export const nearbyPresenceSchema = compactPresenceSchema.extend({
  distance: z.number().int(),
  inRadius: z.boolean(),
});

export const compactMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(['public', 'dm', 'group']),
  senderId: z.string(),
  senderNickname: z.string().optional(),
  content: z.string(),
  links: z.array(z.string()),
  createdAt: epochMs,
  conversationId: z.string().optional(),
  groupId: z.string().optional(),
  readAt: epochMs.optional(),
  position: positionSchema.optional(),
});
export type CompactMessage = z.infer<typeof compactMessageSchema>;

export function compactMessage(
  message: PublicMessage | DmMessage | GroupMessage,
  senderNickname?: string,
): CompactMessage {
  const base: CompactMessage = {
    id: message.id,
    kind: message.kind,
    senderId: message.senderId,
    content: message.content,
    links: message.links,
    createdAt: message.createdAt,
    ...(senderNickname !== undefined ? { senderNickname } : {}),
  };
  if (message.kind === 'public') base.position = message.position;
  if (message.kind === 'dm') {
    base.conversationId = message.conversationId;
    if (message.readAt !== undefined) base.readAt = message.readAt;
  }
  if (message.kind === 'group') base.groupId = message.groupId;
  return base;
}

export const compactMemberSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  role: z.enum(['owner', 'member']),
  joinedAt: epochMs,
  lastReadMessageId: z.string().optional(),
});

export function compactMember(member: GroupMemberWithUser) {
  return {
    userId: member.userId,
    nickname: member.user.nickname,
    role: member.role,
    joinedAt: member.joinedAt,
    ...(member.lastReadMessageId !== undefined
      ? { lastReadMessageId: member.lastReadMessageId }
      : {}),
  };
}

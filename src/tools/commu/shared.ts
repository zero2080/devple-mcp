import type { CallToolResult } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';

import { CommuApiError } from '../../commu/errors.js';
import {
  chatDmEventSchema,
  chatGroupEventSchema,
  directionSchema,
  epochMs,
  groupUpdatedEventSchema,
  positionSchema,
  presenceSchema,
  presenceStateSchema,
  userRoleSchema,
  userStatusSchema,
  worldSnapshotPayloadSchema,
  type DmMessage,
  type GroupMemberWithUser,
  type GroupMessage,
  type Presence,
  type PublicMessage,
  type User,
} from '../../commu/schemas.js';
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

/** 도구 본문을 감싸 예외를 isError 결과로 바꾼다. LLM 이 에러 코드·details 를 읽고 대응할 수 있게 */
export async function runTool<T extends object>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return toolOk(await fn());
  } catch (error) {
    log.debug('tool failed', error);
    return toolError(error);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof CommuApiError) {
    const lines = [`Commu API 오류 ${error.code} (HTTP ${error.status}): ${error.message}`];
    if (error.details) lines.push(`details: ${JSON.stringify(error.details)}`);
    if (error.retryAfterSec !== undefined) lines.push(`retryAfterSec: ${error.retryAfterSec}`);
    return lines.join('\n');
  }
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
  statusMessage: z.string().optional(),
  role: userRoleSchema,
  status: userStatusSchema,
});
export type CompactUser = z.infer<typeof compactUserSchema>;

export function compactUser(user: User): CompactUser {
  return {
    id: user.id,
    nickname: user.nickname,
    ...(user.statusMessage !== undefined ? { statusMessage: user.statusMessage } : {}),
    role: user.role,
    status: user.status,
  };
}

export const compactPresenceSchema = z.object({
  userId: z.string(),
  nickname: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  dir: directionSchema,
  state: presenceStateSchema,
});

export function compactPresence(p: Presence) {
  return {
    userId: p.userId,
    nickname: p.nickname,
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

/** SSE payload 에서 외형 같은 렌더 전용 필드를 걷어낸다. 모르는 타입은 그대로 */
export function compactEventPayload(type: string, payload: unknown): unknown {
  switch (type) {
    case 'chat.dm': {
      const parsed = chatDmEventSchema.safeParse(payload);
      if (!parsed.success) return payload;
      const { sender, peerId, ...message } = parsed.data;
      return { ...compactMessage(message, sender.nickname), peerId };
    }
    case 'chat.group': {
      const parsed = chatGroupEventSchema.safeParse(payload);
      if (!parsed.success) return payload;
      const { sender, ...message } = parsed.data;
      return compactMessage(message, sender.nickname);
    }
    case 'presence.joined': {
      const parsed = presenceSchema.safeParse(payload);
      return parsed.success ? compactPresence(parsed.data) : payload;
    }
    case 'presence.updated': {
      if (payload && typeof payload === 'object' && 'appearance' in payload) {
        const { appearance: _appearance, ...rest } = payload as Record<string, unknown>;
        return { ...rest, appearanceChanged: true };
      }
      return payload;
    }
    case 'group.updated': {
      const parsed = groupUpdatedEventSchema.safeParse(payload);
      if (!parsed.success) return payload;
      const { members, ...group } = parsed.data;
      return { ...group, members: members.map(compactMember) };
    }
    case 'world.snapshot': {
      const parsed = worldSnapshotPayloadSchema.safeParse(payload);
      if (!parsed.success) return payload;
      return {
        mapId: parsed.data.mapId,
        serverTime: parsed.data.serverTime,
        presences: parsed.data.presences.map(compactPresence),
      };
    }
    default:
      return payload;
  }
}

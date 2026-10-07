import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { epochMs } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import {
  compactMessage,
  compactMessageSchema,
  compactUser,
  compactUserSchema,
  runTool,
} from './shared.js';

const pageInput = {
  cursor: z.string().optional().describe('이전 응답의 nextCursor'),
  limit: z.number().int().min(1).max(100).optional().describe('페이지 크기 (기본 50)'),
};

export function registerDmTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_dm_conversations',
    {
      title: 'DM 대화 목록',
      description:
        '내 DM 대화를 최근 활동순으로 돌려준다 (한 페이지 50건). unreadCount 는 상대가 보낸 안 읽은 메시지 수.',
      inputSchema: z.object({ cursor: pageInput.cursor }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            conversationId: z.string(),
            peer: compactUserSchema,
            unreadCount: z.number().int(),
            updatedAt: epochMs,
            lastMessage: compactMessageSchema.optional(),
          }),
        ),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ cursor }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const page = await session.client.listDm(cursor);
        return {
          items: page.items.map((c) => ({
            conversationId: c.id,
            peer: compactUser(c.peer),
            unreadCount: c.unreadCount,
            updatedAt: c.updatedAt,
            ...(c.lastMessage ? { lastMessage: compactMessage(c.lastMessage) } : {}),
          })),
          nextCursor: page.nextCursor,
        };
      }),
  );

  server.registerTool(
    'commu_dm_history',
    {
      title: 'DM 히스토리',
      description:
        '특정 상대와 주고받은 DM 을 최신순으로 돌려준다. cursor 는 이전 페이지의 가장 오래된 messageId.',
      inputSchema: z.object({ userId: z.string().min(1).describe('상대 userId'), ...pageInput }),
      outputSchema: z.object({
        items: z.array(compactMessageSchema),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ userId, cursor, limit }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const page = await session.client.dmHistory(userId, { cursor, limit });
        return { items: page.items.map((m) => compactMessage(m)), nextCursor: page.nextCursor };
      }),
  );

  server.registerTool(
    'commu_dm_send',
    {
      title: 'DM 보내기',
      description:
        '상대 userId 로 1:1 메시지를 보낸다. 위치와 무관하게 전달된다 (친구 관계 불필요). 대화가 없으면 자동 생성. ' +
        '자기 자신·정지 회원에게는 보낼 수 없다.',
      inputSchema: z.object({
        userId: z.string().min(1),
        content: z.string().min(1).max(2000),
      }),
      outputSchema: z.object({ message: compactMessageSchema }),
    },
    ({ userId, content }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const message = await session.client.sendDm(userId, content);
        return { message: compactMessage(message, session.me?.nickname) };
      }),
  );

  server.registerTool(
    'commu_dm_read',
    {
      title: 'DM 읽음 처리',
      description:
        '상대가 보낸 메시지 중 lastMessageId 이하를 읽음 처리한다 (상대에게 읽음 표시가 간다).',
      inputSchema: z.object({ userId: z.string().min(1), lastMessageId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: { idempotentHint: true },
    },
    ({ userId, lastMessageId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        await session.client.readDm(userId, lastMessageId);
        return { ok: true as const };
      }),
  );

  server.registerTool(
    'commu_dm_recall',
    {
      title: 'DM 회수',
      description:
        '내가 보낸 DM 을 상대가 아직 읽지 않았을 때만 회수(삭제)한다. 읽었으면 MESSAGE_ALREADY_READ 로 실패.',
      inputSchema: z.object({ messageId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: { destructiveHint: true },
    },
    ({ messageId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        await session.client.recallDm(messageId);
        return { ok: true as const };
      }),
  );
}

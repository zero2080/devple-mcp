import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { groupSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import {
  compactMember,
  compactMemberSchema,
  compactMessage,
  compactMessageSchema,
  runTool,
} from './shared.js';

const pageInput = {
  cursor: z.string().optional().describe('이전 응답의 nextCursor'),
  limit: z.number().int().min(1).max(100).optional().describe('페이지 크기 (기본 50)'),
};

export function registerGroupTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_groups',
    {
      title: '내 그룹 목록',
      description:
        '내가 속한 그룹을 최근 활동순으로 돌려준다. unreadCount 는 내 읽음 위치 이후 메시지 수.',
      outputSchema: z.object({
        items: z.array(
          groupSchema.extend({
            unreadCount: z.number().int(),
            lastMessage: compactMessageSchema.optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(session, async () => {
        await session.ensureOnline();
        const { items } = await session.client.listGroups();
        return {
          items: items.map(({ lastMessage, ...group }) => ({
            ...group,
            ...(lastMessage ? { lastMessage: compactMessage(lastMessage) } : {}),
          })),
        };
      }),
  );

  server.registerTool(
    'commu_group_detail',
    {
      title: '그룹 상세',
      description: '그룹 정보와 멤버 목록(역할·가입 시각·읽음 위치). 멤버만 볼 수 있다.',
      inputSchema: z.object({ groupId: z.string().min(1) }),
      outputSchema: z.object({ group: groupSchema, members: z.array(compactMemberSchema) }),
      annotations: { readOnlyHint: true },
    },
    ({ groupId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const detail = await session.client.getGroup(groupId);
        return { group: detail.group, members: detail.members.map(compactMember) };
      }),
  );

  server.registerTool(
    'commu_group_create',
    {
      title: '그룹 만들기',
      description:
        '그룹을 만든다 (내가 owner). 이름은 2~100자 한 줄. 초대는 commu_group_members 의 invite.',
      inputSchema: z.object({ name: z.string().min(2).max(100) }),
      outputSchema: z.object({ group: groupSchema }),
    },
    ({ name }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        return { group: await session.client.createGroup(name) };
      }),
  );

  server.registerTool(
    'commu_group_update',
    {
      title: '그룹 이름 변경·해산',
      description:
        'owner 전용. rename 은 name 이 필요하고, dissolve 는 그룹을 해산한다 (멤버 전원에게 통보, 되돌릴 수 없음).',
      inputSchema: z.object({
        groupId: z.string().min(1),
        action: z.enum(['rename', 'dissolve']),
        name: z.string().min(2).max(100).optional().describe('rename 일 때 새 이름'),
      }),
      outputSchema: z.object({ ok: z.literal(true), group: groupSchema.optional() }),
      annotations: { destructiveHint: true },
    },
    ({ groupId, action, name }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        if (action === 'rename') {
          if (!name) throw new Error('rename 에는 name 이 필요해요.');
          return { ok: true as const, group: await session.client.renameGroup(groupId, name) };
        }
        await session.client.dissolveGroup(groupId);
        return { ok: true as const };
      }),
  );

  server.registerTool(
    'commu_group_members',
    {
      title: '그룹 멤버 초대·강퇴·나가기',
      description:
        'invite(owner 전용, 즉시 가입, 최대 10명)·kick(owner 전용) 은 userId 가 필요하다. leave 는 내가 그룹을 나간다 ' +
        '(owner 가 나가면 가장 오래된 멤버가 승계, 마지막 멤버면 그룹 삭제).',
      inputSchema: z.object({
        groupId: z.string().min(1),
        action: z.enum(['invite', 'kick', 'leave']),
        userId: z.string().min(1).optional().describe('invite·kick 대상'),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        member: z
          .object({
            groupId: z.string(),
            userId: z.string(),
            role: z.enum(['owner', 'member']),
            joinedAt: z.number().int(),
          })
          .optional(),
      }),
    },
    ({ groupId, action, userId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        if (action === 'leave') {
          const myId = session.me?.id;
          if (!myId) throw new Error('내 userId 를 알 수 없어요.');
          await session.client.removeMember(groupId, myId);
          return { ok: true as const };
        }
        if (!userId) throw new Error(`${action} 에는 userId 가 필요해요.`);
        if (action === 'invite') {
          const { lastReadMessageId: _ignored, ...member } = await session.client.inviteMember(
            groupId,
            userId,
          );
          return { ok: true as const, member };
        }
        await session.client.removeMember(groupId, userId);
        return { ok: true as const };
      }),
  );

  server.registerTool(
    'commu_group_history',
    {
      title: '그룹 메시지 히스토리',
      description: '그룹 메시지를 최신순으로 돌려준다 (멤버 전용). 가입 전 메시지도 볼 수 있다.',
      inputSchema: z.object({ groupId: z.string().min(1), ...pageInput }),
      outputSchema: z.object({
        items: z.array(compactMessageSchema),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ groupId, cursor, limit }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const page = await session.client.groupHistory(groupId, { cursor, limit });
        return { items: page.items.map((m) => compactMessage(m)), nextCursor: page.nextCursor };
      }),
  );

  server.registerTool(
    'commu_group_send',
    {
      title: '그룹 메시지 보내기',
      description:
        '그룹 전원에게 메시지를 보낸다 (위치 무관, 말풍선 없음). 내 읽음 위치는 자동으로 이 메시지로 옮겨진다.',
      inputSchema: z.object({ groupId: z.string().min(1), content: z.string().min(1).max(2000) }),
      outputSchema: z.object({ message: compactMessageSchema }),
    },
    ({ groupId, content }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const message = await session.client.sendGroup(groupId, content);
        return { message: compactMessage(message, session.me?.nickname) };
      }),
  );

  server.registerTool(
    'commu_group_read',
    {
      title: '그룹 읽음 처리',
      description: '내 읽음 위치를 lastMessageId 로 옮긴다 (앞으로만 움직인다).',
      inputSchema: z.object({ groupId: z.string().min(1), lastMessageId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: { idempotentHint: true },
    },
    ({ groupId, lastMessageId }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        await session.client.readGroup(groupId, lastMessageId);
        return { ok: true as const };
      }),
  );
}

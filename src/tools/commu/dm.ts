import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { CommuSession } from '../../commu/session.js';
import { compactMessage, compactMessageSchema, runTool } from './shared.js';

export function registerDmTools(server: McpServer, session: CommuSession): void {
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

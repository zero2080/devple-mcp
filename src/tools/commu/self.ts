import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { epochMs } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { compactUser, compactUserSchema, runTool } from './shared.js';

export function registerSelfTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_me',
    {
      title: '내 정보',
      description:
        '내 계정(닉네임·상태 메시지·역할)과 서버 설정(근접 반경, 메시지 최대 길이, 그룹 최대 인원)을 돌려준다.',
      outputSchema: z.object({
        me: compactUserSchema,
        nicknameChangeableAt: epochMs.optional(),
        config: z.object({
          proximityRadius: z.number().int(),
          maxMessageLength: z.number().int(),
          maxGroupMembers: z.number().int(),
          defaultMapId: z.string(),
        }),
      }),
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(session, async () => {
        await session.ensureOnline();
        const { me, config } = await session.client.getMe();
        return {
          me: compactUser(me),
          ...(me.nicknameChangeableAt !== undefined
            ? { nicknameChangeableAt: me.nicknameChangeableAt }
            : {}),
          config: {
            proximityRadius: config.proximityRadius,
            maxMessageLength: config.maxMessageLength,
            maxGroupMembers: config.maxGroupMembers,
            defaultMapId: config.defaultMapId,
          },
        };
      }),
  );

  server.registerTool(
    'commu_update_profile',
    {
      title: '프로필 수정',
      description:
        '닉네임(2~12자, 24시간에 1번만 변경 가능)과 상태 메시지(40자 이내 한 줄, 빈 문자열이면 삭제)를 바꾼다. ' +
        '보낸 항목만 바뀐다. 외형(appearance)은 이 도구로 바꾸지 않는다.',
      inputSchema: z.object({
        nickname: z.string().min(2).max(12).optional().describe('새 닉네임'),
        statusMessage: z.string().max(40).optional().describe('새 상태 메시지. "" 이면 삭제'),
      }),
      outputSchema: z.object({ me: compactUserSchema, nicknameChangeableAt: epochMs.optional() }),
    },
    ({ nickname, statusMessage }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const me = await session.client.patchMe({
          ...(nickname !== undefined ? { nickname } : {}),
          ...(statusMessage !== undefined ? { statusMessage } : {}),
        });
        if (session.auth.me) session.auth.me = me;
        return {
          me: compactUser(me),
          ...(me.nicknameChangeableAt !== undefined
            ? { nicknameChangeableAt: me.nicknameChangeableAt }
            : {}),
        };
      }),
  );

  server.registerTool(
    'commu_set_presence',
    {
      title: '상태 전환',
      description: '내 상태를 online 또는 away 로 바꾼다 (주변 사람 화면에 표시).',
      inputSchema: z.object({ state: z.enum(['online', 'away']) }),
      outputSchema: z.object({ state: z.enum(['online', 'away']) }),
      annotations: { idempotentHint: true },
    },
    ({ state }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        await session.client.putPresence(state);
        return { state };
      }),
  );
}

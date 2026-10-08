// C3 행동 도구 7종 (MCP.md 5.3). 입장 전이면 자동 입장(MCP.md 3.1), 서버에 Presence 가 없으면 다시 입장해 한 번 재시도
// (MCP.md 7) — 둘 다 CommuSession.act. 429 는 재시도하지 않고 남은 시간을 오류 문장과 commu_status 로 알린다 (MCP.md 6.3).
// commu_move_to 는 move.ts (C4)
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { appearanceSchema, epochMs } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { compactUser, compactUserSchema, runTool } from './shared.js';
import {
  createdGroup,
  createdGroupSchema,
  listener,
  listenerSchema,
  member,
  memberSchema,
  sentMessage,
  sentMessageSchema,
} from './views.js';

/** 메시지 본문. 길이·문자 판정은 서버가 한다 (MESSAGE_INVALID_CONTENT — 보통 200자, 줄바꿈 가능, 제어 문자 금지) */
const content = z
  .string()
  .min(1)
  .max(2000)
  .describe('보낼 내용 (서버 상한 maxMessageLength, 보통 200자)');

export function registerActionTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_say',
    {
      title: '근접 대화',
      description:
        '내 위치에서 근접 반경(proximityRadius) 안 접속자에게 공개 메시지를 말한다 (말풍선, 저장되지 않음). ' +
        '반경 밖 사람은 듣지 못하니, 말을 걸 사람이 멀면 commu_move_to 로 다가간 뒤 말한다. heardBy 는 들었을 사람. ' +
        '모든 말에 답하지 말고, 같은 상대에게 답 없이 연달아 말하지 않는다.',
      inputSchema: z.object({ content }),
      outputSchema: z.object({ message: sentMessageSchema, heardBy: z.array(listenerSchema) }),
    },
    ({ content: text }) =>
      runTool(session, async () => {
        const { message, heardBy } = await session.say(text);
        return { message: sentMessage(message), heardBy: heardBy.map(listener) };
      }),
  );

  server.registerTool(
    'commu_send_dm',
    {
      title: 'DM 보내기',
      description:
        '상대 userId 에게 1:1 메시지를 보낸다. 위치와 무관하게 전달된다. 대화가 없으면 새로 생긴다 — 먼저 DM 을 거는 일은 ' +
        '아껴서 한다 (AI 는 새 대화·그룹 초대를 합쳐 시간당 10회). 자기 자신·정지 회원에게는 보낼 수 없다.',
      inputSchema: z.object({ userId: z.string().min(1).describe('상대 userId'), content }),
      outputSchema: z.object({ message: sentMessageSchema }),
    },
    ({ userId, content: text }) =>
      runTool(session, async () => {
        const message = await session.act(() => session.client.sendDm(userId, text));
        return { message: sentMessage(message) };
      }),
  );

  server.registerTool(
    'commu_group_send',
    {
      title: '그룹 메시지 보내기',
      description:
        '내가 속한 그룹 전원에게 메시지를 보낸다 (위치 무관). 내 읽음 위치는 이 메시지로 옮겨진다. 그룹은 commu_list_groups 로 본다.',
      inputSchema: z.object({ groupId: z.string().min(1), content }),
      outputSchema: z.object({ message: sentMessageSchema }),
    },
    ({ groupId, content: text }) =>
      runTool(session, async () => {
        const message = await session.act(() => session.client.sendGroup(groupId, text));
        return { message: sentMessage(message) };
      }),
  );

  server.registerTool(
    'commu_group_create',
    {
      title: '그룹 만들기',
      description:
        '그룹을 만든다 (내가 owner, 처음엔 나 혼자). 이름은 2~100자 한 줄. 사람을 넣으려면 commu_group_invite.',
      inputSchema: z.object({ name: z.string().min(2).max(100).describe('그룹 이름') }),
      outputSchema: z.object({ group: createdGroupSchema }),
    },
    ({ name }) =>
      runTool(session, async () => {
        const group = await session.act(() => session.client.createGroup(name));
        return { group: createdGroup(group) };
      }),
  );

  server.registerTool(
    'commu_group_invite',
    {
      title: '그룹에 초대',
      description:
        '내가 owner 인 그룹에 userId 를 넣는다 (수락 절차 없이 바로 가입, 최대 maxGroupMembers 명). 초대는 아껴서 한다 ' +
        '(AI 는 새 대화·초대를 합쳐 시간당 10회). 정지 회원은 초대할 수 없다.',
      inputSchema: z.object({ groupId: z.string().min(1), userId: z.string().min(1) }),
      outputSchema: z.object({ member: memberSchema }),
    },
    ({ groupId, userId }) =>
      runTool(session, async () => {
        const invited = await session.act(() => session.client.inviteMember(groupId, userId));
        return { member: member(invited) };
      }),
  );

  server.registerTool(
    'commu_group_leave',
    {
      title: '그룹 나가기',
      description:
        '그룹에서 나간다. owner 가 나가면 가장 오래된 멤버가 owner 가 되고, 마지막 멤버가 나가면 그룹이 사라진다.',
      inputSchema: z.object({ groupId: z.string().min(1) }),
      outputSchema: z.object({ left: z.literal(true) }),
      annotations: { destructiveHint: true },
    },
    ({ groupId }) =>
      runTool(session, async () => {
        await session.act(async () => {
          const myId = session.me?.id;
          if (myId === undefined) throw new Error('내 userId 를 알 수 없어요.');
          await session.client.removeMember(groupId, myId);
        });
        return { left: true as const };
      }),
  );

  server.registerTool(
    'commu_update_profile',
    {
      title: '프로필 수정',
      description:
        '보낸 항목만 바꾼다. 닉네임 2~12자(24시간에 1번 — NICKNAME_COOLDOWN 이면 details.nextChangeAt 까지 기다린다), ' +
        '상태 메시지 40자 이내 한 줄("" 이면 삭제). 외형(appearance)은 부분 수정이 없고 모든 키를 담은 전체 교체이며, ' +
        '값은 서버가 허용한 아이템·색 ID 만 된다.',
      inputSchema: z.object({
        nickname: z.string().min(2).max(12).optional().describe('새 닉네임'),
        statusMessage: z.string().max(40).optional().describe('새 상태 메시지. "" 이면 삭제'),
        appearance: appearanceSchema.optional().describe('새 외형 전체 (DOMAIN 3.7)'),
      }),
      outputSchema: z.object({ me: compactUserSchema, nicknameChangeableAt: epochMs.optional() }),
    },
    ({ nickname, statusMessage, appearance }) =>
      runTool(session, async () => {
        const me = await session.act(() =>
          session.client.patchMe({
            ...(nickname !== undefined ? { nickname } : {}),
            ...(statusMessage !== undefined ? { statusMessage } : {}),
            ...(appearance !== undefined ? { appearance } : {}),
          }),
        );
        if (session.auth.me) session.auth.me = me;
        return {
          me: compactUser(me),
          ...(me.nicknameChangeableAt !== undefined
            ? { nicknameChangeableAt: me.nicknameChangeableAt }
            : {}),
        };
      }),
  );
}

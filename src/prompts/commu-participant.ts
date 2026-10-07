import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const argsSchema = z.object({
  persona: z.string().optional().describe('캐릭터 성격·말투 (예: "조용하고 호기심 많은 신입")'),
  goal: z
    .string()
    .optional()
    .describe('이번 세션에서 하고 싶은 일 (예: "근처 사람과 인사하고 취미 묻기")'),
});

export function registerCommuParticipantPrompt(server: McpServer): void {
  server.registerPrompt(
    'commu-participant',
    {
      title: 'Commu 참여자로 활동하기',
      description: 'Commu 월드에 들어가 주변 사람과 자연스럽게 어울리는 행동 지침',
      argsSchema,
    },
    ({ persona, goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '너는 2D 도트 가상공간 "Commu" 에 접속한 한 명의 회원이다. commu_* 도구로 월드를 보고, 움직이고, 말한다.',
              persona ? `성격·말투: ${persona}` : '성격·말투: 친근하고 짧게 말하는 회원.',
              goal ? `이번 목표: ${goal}` : '이번 목표: 근처 사람들과 자연스럽게 어울리기.',
              '',
              '행동 규칙',
              '1. 먼저 commu_connect 로 입장하고 proximityRadius·maxMessageLength·내 위치를 확인한다.',
              '2. commu_nearby 로 주변을 본다. 말을 걸고 싶은 사람이 반경 밖이면 commu_move_to 로 반경 안까지 다가간 뒤 commu_say 한다.',
              '3. 대화를 기다릴 때는 commu_events 를 since=nextCursor, waitMs=20000 으로 반복 호출한다. chat.public 은 근처 발화, chat.dm 은 나에게 온 DM, chat.group 은 그룹 메시지다.',
              '4. 내가 보낸 메시지도 이벤트로 돌아온다 (senderId 가 내 id). 그건 응답하지 않는다.',
              '5. 메시지는 maxMessageLength 이내로 짧게, 한국어로. 한 번에 한두 문장. 같은 말을 반복하지 않는다.',
              '6. 누가 DM 을 보내면 commu_dm_send 로 답하고 commu_dm_read 로 읽음 처리한다.',
              '7. 사람이 없거나 조용하면 억지로 말을 만들지 말고 기다린다. 끝낼 때는 가볍게 인사하고 commu_disconnect.',
              '8. 실패(isError) 응답은 코드와 details 를 읽고 한 번만 바로잡아 재시도한다. RATE_LIMITED 면 retryAfterSec 만큼 쉰다.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}

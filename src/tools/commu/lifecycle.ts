import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema, userKindSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { runTool } from './shared.js';

export const sessionStatusSchema = z.object({
  state: z.enum(['idle', 'entering', 'online', 'leaving', 'ended']),
  endedReason: z.enum(['suspended', 'revoked']).nullable(),
  me: z.object({ id: z.string(), nickname: z.string(), kind: userKindSchema }).nullable(),
  mapId: z.string().nullable(),
  position: positionSchema.nullable(),
  proximityRadius: z.number().int().nullable(),
  maxMessageLength: z.number().int().nullable(),
  onlineCount: z.number().int(),
  nearbyCount: z.number().int(),
  unread: z.object({ dm: z.number().int(), group: z.number().int() }),
  inbox: z.object({
    size: z.number().int(),
    dropped: z.number().int(),
    latestCursor: z.number().int(),
  }),
  rateLimit: z.object({ retryAfterSec: z.number().int() }).nullable(),
  idle: z.object({ minutes: z.number(), leaveInSec: z.number().int().nullable() }),
  sse: z.string().nullable(),
  lastEventId: z.string().nullable(),
  baseUrl: z.string(),
  moving: z.boolean(),
});

const enterResultSchema = z.object({
  me: z.object({ id: z.string(), nickname: z.string(), kind: userKindSchema }),
  position: positionSchema.nullable(),
  mapId: z.string().nullable(),
  nearbyCount: z.number().int(),
  onlineCount: z.number().int(),
  proximityRadius: z.number().int().nullable(),
  maxMessageLength: z.number().int().nullable(),
});

/** MCP.md 5.1 상태·수명 도구: commu_enter · commu_leave · commu_status */
export function registerLifecycleTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_enter',
    {
      title: 'Commu 입장',
      description:
        'AI 계정으로 Commu 월드에 입장한다 (토큰 교환 → SSE 연결 → 스냅샷). 내 닉네임·위치, 주변 인원 수, 근접 반경(proximityRadius), ' +
        '메시지 최대 길이(maxMessageLength)를 돌려준다. 이미 입장했으면 그대로. 행동 도구(say·move_to·send_dm·group_*)는 ' +
        '입장 전에 부르면 자동으로 입장하지만, 먼저 이걸로 상황을 확인하는 것이 좋다. 당신은 AI 계정이다 — 사람인 척하지 않는다. ' +
        '행동 원칙 전체는 commu_guidelines 프롬프트에 있다.',
      outputSchema: enterResultSchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    () =>
      runTool(session, async () => {
        const status = await session.enter();
        return {
          me: status.me ?? { id: '?', nickname: '?', kind: 'ai' as const },
          position: status.position,
          mapId: status.mapId,
          nearbyCount: status.nearbyCount,
          onlineCount: status.onlineCount,
          proximityRadius: status.proximityRadius,
          maxMessageLength: status.maxMessageLength,
        };
      }),
  );

  server.registerTool(
    'commu_leave',
    {
      title: 'Commu 퇴장',
      description:
        '월드에서 나간다 (SSE 종료, 서버가 잠시 뒤 퇴장 처리). 받은 메시지 보관함은 유지된다. 다음 행동 도구 호출 때 자동으로 다시 입장한다. ' +
        'farewell 을 주면 나가기 전에 근접 대화로 한마디 한다(입장 중일 때만) — 머물겠다고 말했으면 인사 없이 사라지지 않는다.',
      inputSchema: z.object({
        farewell: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('나가기 전 근접 대화 한마디 (입장 중일 때만 보낸다)'),
      }),
      outputSchema: z.object({
        left: z.literal(true),
        /** farewell 을 들었을 사람 수 (보냈을 때만) */
        farewellHeardBy: z.number().int().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    ({ farewell }) =>
      runTool(session, async () => {
        let farewellHeardBy: number | undefined;
        if (farewell !== undefined && session.online) {
          farewellHeardBy = (await session.say(farewell)).heardBy.length;
        }
        await session.leave('tool');
        return {
          left: true as const,
          ...(farewellHeardBy !== undefined ? { farewellHeardBy } : {}),
        };
      }),
  );

  server.registerTool(
    'commu_status',
    {
      title: 'Commu 상태',
      description:
        '연결 상태(idle·entering·online·leaving·ended), 내 정보·위치, 접속자·반경 안 인원, 안 읽은 DM·그룹 수, 보관함 크기, ' +
        '429 뒤 남은 대기 시간, 자동 퇴장까지 남은 시간을 돌려준다. 메모리만 보며 입장하지 않는다.',
      outputSchema: sessionStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => runTool(session, async () => session.status()),
  );
}

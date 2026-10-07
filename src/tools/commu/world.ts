import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { compactMessage, compactMessageSchema, nearbyPresenceSchema, runTool } from './shared.js';

export function registerWorldTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_nearby',
    {
      title: '주변 접속자',
      description:
        '내 위치 기준으로 접속자를 거리순으로 돌려준다. inRadius 가 true 인 사람만 내 근접 대화(commu_say)를 듣는다. ' +
        '거리는 체비쇼프 거리(max(|dx|,|dy|)) 타일 수.',
      inputSchema: z.object({
        radius: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe('기준 반경. 생략하면 서버 설정값(보통 5)'),
        includeOutside: z.boolean().optional().describe('반경 밖 접속자도 포함할지 (기본 true)'),
      }),
      outputSchema: z.object({
        me: positionSchema.nullable(),
        radius: z.number().int(),
        onlineCount: z.number().int(),
        inRadius: z.array(nearbyPresenceSchema),
        outside: z.array(nearbyPresenceSchema),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ radius, includeOutside }) =>
      runTool(session, async () => {
        await session.ensureOnline();
        const r = radius ?? session.serverConfig?.proximityRadius ?? 5;
        const all = session.world.nearby(r);
        return {
          me: session.world.me()?.position ?? null,
          radius: r,
          onlineCount: session.world.size,
          inRadius: all.filter((p) => p.inRadius),
          outside: includeOutside === false ? [] : all.filter((p) => !p.inRadius),
        };
      }),
  );

  server.registerTool(
    'commu_move_to',
    {
      title: '이동',
      description:
        '타일 좌표 (x, y) 로 걸어간다. 맵이 로드돼 있으면 벽·다른 캐릭터를 피해 경로를 찾고, 없으면 직선으로 가며 서버 판정(409)에 맞춰 보정한다. ' +
        '목적지에 누가 서 있으면 그 직전 타일에서 멈춘다 (한 타일에 한 명). 결과의 position 이 서버가 인정한 내 위치다. ' +
        '누군가에게 말을 걸려면 그 사람과의 거리가 근접 반경 이내가 되도록 이동한 뒤 commu_say 를 쓴다.',
      inputSchema: z.object({
        x: z.number().int().min(0).describe('목적지 타일 X'),
        y: z.number().int().min(0).describe('목적지 타일 Y'),
        maxHops: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('최대 이동 요청 수 (기본 100, 요청당 최대 3칸)'),
      }),
      outputSchema: z.object({
        reached: z.boolean(),
        from: positionSchema,
        position: positionSchema,
        distanceToTarget: z.number().int(),
        hops: z.number().int(),
        plannedHops: z.number().int(),
        pathLength: z.number().int().nullable(),
        rejections: z.array(
          z.object({ x: z.number().int(), y: z.number().int(), reason: z.string() }),
        ),
        stoppedBecause: z.string().optional(),
      }),
    },
    ({ x, y, maxHops }) =>
      runTool(session, () => session.moveTo({ x, y }, maxHops !== undefined ? { maxHops } : {})),
  );

  server.registerTool(
    'commu_say',
    {
      title: '근접 대화',
      description:
        '내 위치 기준 근접 반경 안의 접속자에게 공개 메시지를 보낸다 (말풍선). 범위 밖 사람은 듣지 못한다. ' +
        '길이는 maxMessageLength(보통 200자) 이내, 줄바꿈 가능, 제어 문자 금지. heardBy 는 들었을 사람의 닉네임.',
      inputSchema: z.object({
        content: z.string().min(1).max(2000).describe('보낼 내용'),
      }),
      outputSchema: z.object({ message: compactMessageSchema, heardBy: z.array(z.string()) }),
    },
    ({ content }) =>
      runTool(session, async () => {
        const { message, heardBy } = await session.say(content);
        return { message: compactMessage(message, session.me?.nickname), heardBy };
      }),
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { runTool } from './shared.js';

export function registerWorldTools(server: McpServer, session: CommuSession): void {
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
}

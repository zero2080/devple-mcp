// C4 이동 도구 (MCP.md 5.3): A* 경로 · 타일당 150ms · 200ms 배칭 · 한 번에 40타일. 걷기는 commu/mover.ts,
// 목적지 해석({ userId } → 옆 빈 칸)과 자동 입장·이동 직렬화는 CommuSession.moveTo
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema, tileCoord } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { runTool } from './shared.js';

const tileSchema = z.object({ x: tileCoord, y: tileCoord });

export const moveResultSchema = z.object({
  status: z.enum(['arrived', 'blocked', 'partial']),
  reason: z
    .enum([
      'collision',
      'not_ready',
      'no_path',
      'occupied',
      'too_far',
      'user_offline',
      'other_map',
      'no_free_tile',
    ])
    .optional(),
  from: positionSchema,
  position: positionSchema,
  goal: tileSchema,
  tilesMoved: z.number().int(),
  remainingTiles: z.number().int(),
  requests: z.number().int(),
  rejections: z.number().int(),
  replans: z.number().int(),
  user: z
    .object({ userId: z.string(), distance: z.number().int(), withinProximity: z.boolean() })
    .optional(),
});

const moveInputSchema = z
  .object({
    x: tileCoord.optional().describe('목적지 타일 X (y 와 함께)'),
    y: tileCoord.optional().describe('목적지 타일 Y (x 와 함께)'),
    userId: z.string().min(1).optional().describe('이 사람 옆 빈 칸으로 간다 (x·y 대신)'),
  })
  .refine((v) => (v.userId !== undefined) !== (v.x !== undefined && v.y !== undefined), {
    message: '{ x, y } 또는 { userId } 중 하나만 준다',
  });

export function registerMoveTool(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_move_to',
    {
      title: '이동',
      description:
        '타일 좌표 { x, y } 또는 사람 { userId } 로 걸어간다. 맵의 벽과 다른 캐릭터를 피해 4방향 A* 경로로 가고(타일당 150ms), ' +
        'userId 면 그 사람 옆 빈 칸이 목적지다. 좌표에 누가 서 있으면 직전 칸에서 멈춰 그쪽을 본다. ' +
        '한 번에 최대 40타일(약 6초) — 더 멀면 partial 로 멈추니 다시 부른다. 갈 수 없으면 blocked 와 reason ' +
        '(collision 벽, not_ready 아직 만들어지지 않은 곳, no_path 길 없음, occupied·too_far 서버 거부가 거듭됨, ' +
        'user_offline, other_map, no_free_tile). 끝없는 지상 월드에서는 좌표가 음수일 수 있고, 아직 만들어지지 않은 곳은 ' +
        '벽처럼 지나가지 못한다(내가 다가가도 생기지 않는다 — 사람이 다가가면 생긴다). ' +
        '결과의 position 이 서버가 인정한 내 위치, remainingTiles 는 목적지까지 남은 칸. ' +
        '말을 걸려면 상대가 근접 반경 안에 있어야 한다 — userId 로 갔으면 user.withinProximity 로 확인한다.',
      inputSchema: moveInputSchema,
      outputSchema: moveResultSchema,
    },
    ({ x, y, userId }) =>
      runTool(session, () => {
        const target =
          userId !== undefined ? { userId } : x !== undefined && y !== undefined ? { x, y } : null;
        if (!target) throw new Error('{ x, y } 또는 { userId } 중 하나를 준다');
        return session.moveTo(target);
      }),
  );
}

// 이동 도구 (MCP.md 5.3): commu_move_to — A* 경로 · 타일당 150ms · 200ms 배칭 · 한 번에 40타일 (C4·W6),
// commu_go_home — 첫 마을로 순간이동 (W6). 걷기는 commu/mover.ts, 목적지 해석({ userId } → 옆 빈 칸, { place } → 영역 안
// 가장 가까운 빈 칸)과 자동 입장·이동 직렬화·귀환의 이동 중단은 CommuSession
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { CommuApiError } from '../../commu/errors.js';
import { positionSchema, tileCoord } from '../../commu/schemas.js';
import type { CommuSession, MoveTarget } from '../../commu/session.js';
import { runTool } from './shared.js';
import { areaSchema, placeSchema } from './views.js';

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
      'unknown_place',
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
  place: placeSchema.optional(),
});

const moveInputSchema = z
  .object({
    x: tileCoord.optional().describe('목적지 타일 X (y 와 함께)'),
    y: tileCoord.optional().describe('목적지 타일 Y (x 와 함께)'),
    userId: z.string().min(1).optional().describe('이 사람 옆 빈 칸으로 간다 (x·y 대신)'),
    place: z
      .string()
      .min(1)
      .max(20)
      .optional()
      .describe('근처 장소 이름 — commu_look_around 의 places[].name 그대로 (x·y 대신)'),
  })
  .refine(
    (v) =>
      [
        v.x !== undefined && v.y !== undefined,
        v.userId !== undefined,
        v.place !== undefined,
      ].filter(Boolean).length === 1 && (v.x === undefined) === (v.y === undefined),
    { message: '{ x, y } 또는 { userId } 또는 { place } 중 하나만 준다' },
  );

const goHomeResultSchema = z.object({
  from: positionSchema,
  position: positionSchema,
  area: areaSchema.nullable(),
});

export function registerMoveTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_move_to',
    {
      title: '이동',
      description:
        '타일 좌표 { x, y }, 사람 { userId }, 또는 근처 장소 { place } 로 걸어간다. 맵의 벽과 다른 캐릭터를 피해 4방향 A* 경로로 가고(타일당 150ms), ' +
        'userId 면 그 사람 옆 빈 칸, place 면 그 장소 영역 안에서 걸어서 가장 가까운 빈 칸이 목적지다(이름은 commu_look_around 의 places 그대로, ' +
        '같은 이름이 여럿이면 가장 가까운 것). 좌표에 누가 서 있으면 직전 칸에서 멈춰 그쪽을 본다. ' +
        '한 번에 최대 40타일(약 6초) — 더 멀면 partial 로 멈추니 다시 부른다. 갈 수 없으면 blocked 와 reason ' +
        '(collision 벽, not_ready 아직 만들어지지 않은 곳, no_path 길 없음, occupied·too_far 서버 거부가 거듭됨, ' +
        'user_offline, other_map, no_free_tile 빈 칸 없음 — 물·집처럼 안에 설 수 없는 장소면 그 옆 좌표로 간다, ' +
        'unknown_place 근처에 그 이름의 장소 없음). 끝없는 지상 월드에서는 좌표가 음수일 수 있고, 아직 만들어지지 않은 곳은 ' +
        '벽처럼 지나가지 못한다(내가 다가가도 생기지 않는다 — 사람이 다가가면 생긴다). ' +
        '결과의 position 이 서버가 인정한 내 위치, remainingTiles 는 목적지까지 남은 칸. ' +
        '말을 걸려면 상대가 근접 반경 안에 있어야 한다 — userId 로 갔으면 user.withinProximity 로 확인한다.',
      inputSchema: moveInputSchema,
      outputSchema: moveResultSchema,
    },
    ({ x, y, userId, place }) =>
      runTool(session, () => {
        const target: MoveTarget | null =
          userId !== undefined
            ? { userId }
            : place !== undefined
              ? { place }
              : x !== undefined && y !== undefined
                ? { x, y }
                : null;
        if (!target) throw new Error('{ x, y } 또는 { userId } 또는 { place } 중 하나를 준다');
        return session.moveTo(target);
      }),
  );

  server.registerTool(
    'commu_go_home',
    {
      title: '마을 귀환',
      description:
        '첫 마을로 순간이동한다(끝없는 지상 월드는 원점의 첫 마을, 옛 맵은 스폰 — 그 칸에 누가 있으면 가까운 빈 칸). ' +
        '멀리 와서 길을 잃었거나 사람들이 모이는 곳으로 돌아갈 때 쓴다. 10초에 한 번만 된다(너무 빠르면 남은 초를 알려 준다 — ' +
        '자동으로 다시 하지 않는다). 걷고 있던 commu_move_to 는 partial 로 끝난다. 주변 사람이 바뀌니 commu_look_around 로 다시 본다. ' +
        '결과 position 이 새 위치, area 는 새 위치의 구역(지상 월드만).',
      outputSchema: goHomeResultSchema,
    },
    () =>
      runTool(session, async () => {
        try {
          return await session.goHome();
        } catch (error) {
          if (error instanceof CommuApiError && error.code === 'RATE_LIMITED') {
            throw new Error(
              `마을 귀환은 10초에 한 번입니다. ${String(error.retryAfterSec ?? 10)}초 뒤에 다시 하세요`,
              { cause: error },
            );
          }
          throw error;
        }
      }),
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { SSE_EVENT_TYPES } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { compactEventPayload, runTool } from './shared.js';

const MAX_WAIT_MS = 25_000;

export function registerEventTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_events',
    {
      title: '수신 이벤트 읽기',
      description:
        'SSE 로 받은 이벤트(근접 대화 chat.public, DM chat.dm, 그룹 chat.group, 입장·퇴장 presence.*, 공지 system.notice 등)를 커서 이후부터 돌려준다. ' +
        '처음엔 since 없이 불러 최근 것과 nextCursor 를 받고, 이후엔 since=nextCursor 로 반복한다. ' +
        'waitMs 를 주면 새 이벤트가 올 때까지 그 시간(최대 25초)까지 기다렸다가 돌아온다 — 대화를 기다릴 때 이걸로 폴링한다. ' +
        'world.positions 와 system.heartbeat 는 버퍼에 쌓지 않는다 (위치는 commu_nearby 로 본다).',
      inputSchema: z.object({
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('이전 응답의 nextCursor. 생략하면 최근 이벤트 꼬리'),
        types: z.array(z.enum(SSE_EVENT_TYPES)).optional().describe('이 타입만 (생략하면 전부)'),
        limit: z.number().int().min(1).max(200).optional().describe('최대 개수 (기본 50)'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe('새 이벤트를 기다릴 시간 ms (기본 0)'),
      }),
      outputSchema: z.object({
        events: z.array(
          z.object({
            cursor: z.number().int(),
            id: z.string(),
            type: z.string(),
            ts: z.number().int(),
            payload: z.unknown(),
          }),
        ),
        nextCursor: z.number().int(),
        hasMore: z.boolean(),
        dropped: z.boolean(),
        waited: z.boolean(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ since, types, limit, waitMs }) =>
      runTool(async () => {
        await session.ensureConnected();
        let waited = false;
        if (since !== undefined && waitMs !== undefined && waitMs > 0) {
          waited = true;
          await session.events.waitFor(since, types, Math.min(waitMs, MAX_WAIT_MS));
        }
        const page = session.events.since(since, { types, limit });
        return {
          events: page.events.map((e) => ({
            cursor: e.cursor,
            id: e.id,
            type: e.type,
            ts: e.ts,
            payload: compactEventPayload(e.type, e.payload),
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          dropped: page.dropped,
          waited,
        };
      }),
  );
}

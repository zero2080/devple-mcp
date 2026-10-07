import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { positionSchema, userRoleSchema } from '../../commu/schemas.js';
import type { CommuSession } from '../../commu/session.js';
import { runTool } from './shared.js';

export const sessionStatusSchema = z.object({
  state: z.enum(['disconnected', 'connecting', 'connected', 'ended']),
  sse: z.string().nullable(),
  baseUrl: z.string(),
  endedReason: z.enum(['suspended', 'revoked']).nullable(),
  me: z.object({ id: z.string(), nickname: z.string(), role: userRoleSchema }).nullable(),
  mapId: z.string().nullable(),
  position: positionSchema.nullable(),
  proximityRadius: z.number().int().nullable(),
  maxMessageLength: z.number().int().nullable(),
  onlineCount: z.number().int(),
  nearbyCount: z.number().int(),
  lastEventId: z.string().nullable(),
  bufferedEvents: z.number().int(),
  latestEventCursor: z.number().int(),
  mapLoaded: z.boolean(),
});

export function registerConnectionTools(server: McpServer, session: CommuSession): void {
  server.registerTool(
    'commu_connect',
    {
      title: 'Commu 접속',
      description:
        '접근 키(환경변수)로 로그인하고 SSE 를 연결해 월드에 입장한다. 이미 연결돼 있으면 상태만 돌려준다. ' +
        '다른 commu_* 도구도 필요하면 자동으로 연결하지만, 먼저 이걸 호출해 내 닉네임·근접 반경(proximityRadius)·' +
        '메시지 길이 제한(maxMessageLength)·현재 위치를 확인하는 것이 좋다.',
      outputSchema: sessionStatusSchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    () => runTool(() => session.connect()),
  );

  server.registerTool(
    'commu_status',
    {
      title: 'Commu 상태',
      description:
        '연결 상태, 내 위치, 접속자 수, 반경 안 인원, 버퍼에 쌓인 이벤트 수·최신 커서를 돌려준다. 네트워크 호출 없음.',
      outputSchema: sessionStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => runTool(async () => session.status()),
  );

  server.registerTool(
    'commu_disconnect',
    {
      title: 'Commu 접속 종료',
      description: 'SSE 를 닫고 로그아웃한다 (월드에서 퇴장). 다시 활동하려면 commu_connect.',
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: { idempotentHint: true },
    },
    () =>
      runTool(async () => {
        await session.disconnect();
        return { ok: true as const };
      }),
  );
}

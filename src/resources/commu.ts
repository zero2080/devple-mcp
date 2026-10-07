import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../commu/session.js';
import { compactUser } from '../tools/commu/shared.js';

export const COMMU_ME_URI = 'commu://me';
export const COMMU_PRESENCES_URI = 'commu://world/presences';

export function registerCommuResources(server: McpServer, session: CommuSession): void {
  server.registerResource(
    'commu-me',
    COMMU_ME_URI,
    {
      title: '내 Commu 계정과 세션 상태',
      description: '접속한 계정(닉네임·역할)과 연결 상태·현재 위치·근접 반경',
      mimeType: 'application/json',
    },
    async (uri) => {
      await session.ensureConnected();
      const me = session.me;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              { me: me ? compactUser(me) : null, status: session.status() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    'commu-presences',
    COMMU_PRESENCES_URI,
    {
      title: '현재 접속자',
      description: '같은 맵의 접속자와 나와의 거리 (근접 반경 안이면 inRadius=true)',
      mimeType: 'application/json',
    },
    async (uri) => {
      await session.ensureConnected();
      const radius = session.serverConfig?.proximityRadius ?? 5;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                mapId: session.world.mapId,
                me: session.world.me()?.position ?? null,
                radius,
                presences: session.world.nearby(radius),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

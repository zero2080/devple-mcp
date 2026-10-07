import type { McpServer } from '@modelcontextprotocol/server';

import { SERVER_DESCRIPTION, SERVER_NAME, SERVER_VERSION } from '../meta.js';

export const SERVER_INFO_URI = 'devple://server/info';

export function registerServerInfoResource(server: McpServer): void {
  server.registerResource(
    'server-info',
    SERVER_INFO_URI,
    {
      title: 'Server Info',
      description: '이 MCP 서버의 이름·버전·설명',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            { name: SERVER_NAME, version: SERVER_VERSION, description: SERVER_DESCRIPTION },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

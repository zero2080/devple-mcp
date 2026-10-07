import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const inputSchema = z.object({
  message: z.string().max(1000).optional().describe('그대로 돌려받을 메시지. 없으면 "pong".'),
});

const outputSchema = z.object({
  pong: z.string(),
  receivedAt: z.string().describe('서버가 요청을 받은 시각 (ISO 8601)'),
});

export function registerPingTool(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: '서버 연결을 확인한다. 메시지를 주면 그대로 돌려준다.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) => {
      const output = { pong: message ?? 'pong', receivedAt: new Date().toISOString() };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

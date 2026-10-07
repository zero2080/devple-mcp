import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// MCP 프롬프트 인자는 문자열만 허용된다.
const argsSchema = z.object({
  text: z.string().describe('요약할 본문'),
  language: z.string().optional().describe('요약 언어. 기본 한국어'),
});

export function registerSummarizePrompt(server: McpServer): void {
  server.registerPrompt(
    'summarize',
    {
      title: 'Summarize',
      description: '주어진 글을 핵심만 간결하게 요약한다.',
      argsSchema,
    },
    ({ text, language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `다음 글을 ${language ?? '한국어'}로 3문장 이내로 요약해 주세요.`,
              '',
              '---',
              text,
              '---',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}

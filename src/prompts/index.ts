import type { McpServer } from '@modelcontextprotocol/server';

import { registerCommuParticipantPrompt } from './commu-participant.js';
import { registerSummarizePrompt } from './summarize.js';

/** 새 프롬프트는 파일 하나로 만들고 여기서 등록한다. */
export function registerPrompts(server: McpServer): void {
  registerSummarizePrompt(server);
  registerCommuParticipantPrompt(server);
}

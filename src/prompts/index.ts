import type { McpServer } from '@modelcontextprotocol/server';

import { registerCommuGuidelinesPrompt } from './commu-guidelines.js';
import { registerSummarizePrompt } from './summarize.js';

/** 새 프롬프트는 파일 하나로 만들고 여기서 등록한다. */
export function registerPrompts(server: McpServer): void {
  registerSummarizePrompt(server);
  registerCommuGuidelinesPrompt(server);
}

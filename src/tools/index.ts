import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../context.js';
import { registerCommuTools } from './commu/index.js';
import { registerPingTool } from './ping.js';

/** 새 도구는 파일 하나로 만들고 여기서 등록한다. */
export function registerTools(server: McpServer, ctx: AppContext): void {
  registerPingTool(server);
  registerCommuTools(server, ctx.session);
}

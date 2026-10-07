import type { McpServer } from '@modelcontextprotocol/server';

import type { AppContext } from '../context.js';
import { registerCommuResources } from './commu.js';
import { registerServerInfoResource } from './server-info.js';

/** 새 리소스는 파일 하나로 만들고 여기서 등록한다. */
export function registerResources(server: McpServer, ctx: AppContext): void {
  registerServerInfoResource(server);
  registerCommuResources(server, ctx.session);
}

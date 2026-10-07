import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerDmTools } from './dm.js';
import { registerGroupTools } from './groups.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerSelfTools } from './self.js';
import { registerUserTools } from './users.js';
import { registerWorldTools } from './world.js';

/** Commu AI 계정 도구 (MCP.md 5). C1: 수명 3종 확정, 나머지는 C2·C3 에서 17종으로 교체 */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerLifecycleTools(server, session);
  registerSelfTools(server, session);
  registerWorldTools(server, session);
  registerUserTools(server, session);
  registerDmTools(server, session);
  registerGroupTools(server, session);
}

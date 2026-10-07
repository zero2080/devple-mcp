import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerAroundTools } from './around.js';
import { registerDmTools } from './dm.js';
import { registerGroupTools } from './groups.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerReadingTools } from './reading.js';
import { registerSelfTools } from './self.js';
import { registerWorldTools } from './world.js';

/** Commu AI 계정 도구 (MCP.md 5). C1 수명 3종·C2 읽기 6종 확정, 나머지 임시 도구는 C3·C4 에서 교체 */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerLifecycleTools(server, session);
  registerAroundTools(server, session);
  registerReadingTools(server, session);
  registerSelfTools(server, session);
  registerWorldTools(server, session);
  registerDmTools(server, session);
  registerGroupTools(server, session);
}

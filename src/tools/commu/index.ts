import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerActionTools } from './actions.js';
import { registerAroundTools } from './around.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerReadingTools } from './reading.js';
import { registerWorldTools } from './world.js';

/** Commu AI 계정 도구 (MCP.md 5). C1 수명 3종·C2 읽기 6종·C3 행동 7종 확정, commu_move_to 는 C4 에서 교체 */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerLifecycleTools(server, session);
  registerAroundTools(server, session);
  registerReadingTools(server, session);
  registerActionTools(server, session);
  registerWorldTools(server, session);
}

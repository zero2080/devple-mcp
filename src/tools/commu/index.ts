import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerActionTools } from './actions.js';
import { registerAppearanceTool } from './appearance.js';
import { registerAroundTools } from './around.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerMoveTool } from './move.js';
import { registerReadingTools } from './reading.js';

/** Commu AI 계정 도구 18종 (MCP.md 5, 1.1): C1 수명 3종 · C2 읽기 6종 · C3 행동 7종 · C4 이동 1종 · 외형 조회 1종 */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerLifecycleTools(server, session);
  registerAroundTools(server, session);
  registerReadingTools(server, session);
  registerAppearanceTool(server, session);
  registerActionTools(server, session);
  registerMoveTool(server, session);
}

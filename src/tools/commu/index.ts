import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerActionTools } from './actions.js';
import { registerAppearanceTool } from './appearance.js';
import { registerAroundTools } from './around.js';
import { registerLifecycleTools } from './lifecycle.js';
import { registerMoveTools } from './move.js';
import { registerReadingTools } from './reading.js';

/**
 * Commu AI 계정 도구 20종 (MCP.md 5, 1.3): 수명 3종 · 읽기 8종(외형 조회·기다리기 포함) · 행동 7종 · 이동 2종(move_to·go_home)
 */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerLifecycleTools(server, session);
  registerAroundTools(server, session);
  registerReadingTools(server, session);
  registerAppearanceTool(server, session);
  registerActionTools(server, session);
  registerMoveTools(server, session);
}

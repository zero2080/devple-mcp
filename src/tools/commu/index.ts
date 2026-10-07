import type { McpServer } from '@modelcontextprotocol/server';

import type { CommuSession } from '../../commu/session.js';
import { registerConnectionTools } from './connection.js';
import { registerDmTools } from './dm.js';
import { registerEventTools } from './events.js';
import { registerGroupTools } from './groups.js';
import { registerSelfTools } from './self.js';
import { registerUserTools } from './users.js';
import { registerWorldTools } from './world.js';

/** Commu AI 참여자 도구 25개 (API_CONTRACT 2.2~2.7 + SSE 3장) */
export function registerCommuTools(server: McpServer, session: CommuSession): void {
  registerConnectionTools(server, session);
  registerSelfTools(server, session);
  registerWorldTools(server, session);
  registerUserTools(server, session);
  registerDmTools(server, session);
  registerGroupTools(server, session);
  registerEventTools(server, session);
}

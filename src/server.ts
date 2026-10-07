import { McpServer } from '@modelcontextprotocol/server';

import { loadCommuConfig } from './commu/config.js';
import { CommuSession } from './commu/session.js';
import type { AppContext } from './context.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

export interface CreateServerOptions {
  /** 테스트나 임베딩에서 세션을 주입한다. 없으면 환경변수로 만든다 */
  session?: CommuSession;
}

/**
 * 트랜스포트와 무관한 서버 인스턴스를 만든다.
 * stdio 진입점(`index.ts`)과 테스트(InMemoryTransport)가 같은 팩토리를 공유한다.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const ctx: AppContext = {
    session: options.session ?? new CommuSession(loadCommuConfig()),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Devple MCP 서버. Commu(2D 도트 가상공간 채팅)에 한 회원으로 참여하는 commu_* 도구를 제공한다.',
        '시작: commu_connect → commu_nearby 로 주변 확인 → 필요하면 commu_move_to 로 다가가 commu_say.',
        '수신: commu_events 를 since=nextCursor, waitMs 와 함께 반복 호출해 chat.public / chat.dm / chat.group 을 받는다.',
        '행동 지침 전체는 commu-participant 프롬프트에 있다.',
      ].join('\n'),
    },
  );

  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}

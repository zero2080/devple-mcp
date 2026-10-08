// MCP.md 6 안전 규칙 (C5): 토큰·접근 토큰·SSE 티켓이 어떤 로그·도구 결과·리소스·프롬프트에도 없고, 메시지 본문은 info 이하
// 로그에 없다 (6.4). 6.2 행동 원칙이 말하는 도구의 description·commu_guidelines 프롬프트·서버 instructions 에 있다.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GUIDELINES, GUIDELINES_BRIEF } from './commu/guidelines.js';
import { CommuSession } from './commu/session.js';
import { createServer } from './server.js';
import { FakeCommu, TEST_AI_TOKEN, waitUntil } from './test/fake-commu.js';

type Structured = Record<string, unknown>;

describe('안전 (MCP.md 6): 토큰 유출 없음 · 행동 원칙 노출', () => {
  const fake = new FakeCommu({
    others: [
      { id: 'u2', nickname: '도트', online: true, position: { x: 23, y: 15 } },
      { id: 'u3', nickname: '멀리', online: true, position: { x: 35, y: 28 } },
    ],
  });
  /** 테스트 동안 stderr 로 간 모든 로그 */
  const stderrLines: string[] = [];
  /** 모든 도구 결과·리소스·프롬프트·도구 목록 (JSON 문자열) */
  const outputs: string[] = [];
  let session: CommuSession;
  let client: Client;
  let close: () => Promise<void>;
  let restore: () => void;

  const call = async (name: string, args: Structured = {}) => {
    const result = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(result));
    return result;
  };

  beforeAll(async () => {
    await fake.start();
    const previousLevel = process.env['DEVPLE_MCP_LOG_LEVEL'];
    process.env['DEVPLE_MCP_LOG_LEVEL'] = 'debug';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    restore = () => {
      process.stderr.write = originalWrite;
      if (previousLevel === undefined) delete process.env['DEVPLE_MCP_LOG_LEVEL'];
      else process.env['DEVPLE_MCP_LOG_LEVEL'] = previousLevel;
    };

    session = new CommuSession(
      {
        enabled: true,
        aiToken: TEST_AI_TOKEN,
        baseUrl: fake.origin,
        apiBaseUrl: fake.baseUrl,
        idleMinutes: 10,
      },
      { move: { tileMs: 0, batchMs: 0 }, sse: { backoff: { initialMs: 1, maxMs: 5, jitter: 0 } } },
    );
    const server = createServer({ session });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'safety-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
      await session.leave('shutdown');
      await fake.stop();
    };
  });

  afterAll(async () => {
    try {
      await close();
    } finally {
      restore();
    }
  });

  it('입장·대화·DM·그룹·재연결·재교환·429·폐기까지 돌린 뒤: 로그·결과에 AI 토큰·접근 토큰·티켓이 없고, 본문은 info 이하 로그에 없다', async () => {
    const SAID = '근접 발화 본문 SECRET-SAY-7f3a';
    const SENT = 'DM 본문 SECRET-DM-9c1e';
    const RECEIVED = '받은 DM 본문 SECRET-IN-4b2d';

    await call('commu_status');
    await call('commu_enter');
    await call('commu_look_around');
    await call('commu_say', { content: SAID });
    await call('commu_move_to', { x: 20, y: 17 });
    await call('commu_send_dm', { userId: 'u2', content: SENT });
    fake.receiveDm('u2', RECEIVED);
    await waitUntil(() => session.inbox.size >= 1);
    await call('commu_read_inbox');
    await call('commu_dm_history', { userId: 'u2' });
    await call('commu_find_user', { nickname: '도트' });
    const created = await call('commu_group_create', { name: '안전 점검 모임' });
    const group = (created.structuredContent as Structured)['group'] as Structured;
    const groupId = String(group['groupId']);
    await call('commu_group_invite', { groupId, userId: 'u2' });
    await call('commu_group_send', { groupId, content: `그룹 본문 ${SENT}` });
    await call('commu_list_groups');
    await call('commu_group_history', { groupId });
    await call('commu_group_leave', { groupId });
    await call('commu_update_profile', { statusMessage: '산책 중' });

    // 오류 경로: 429, 검증 실패
    fake.rateLimitNextMessage(2);
    expect((await call('commu_say', { content: '빠르게' })).isError).toBe(true);
    expect((await call('commu_send_dm', { userId: 'u2', content: '  ' })).isError).toBe(true);

    // 재연결 (새 티켓) 과 재교환 (401 → 새 접근 토큰)
    fake.dropStreams();
    await waitUntil(() => fake.streamCount === 1, 5000);
    fake.expireAccessToken();
    expect((await call('commu_find_user', { nickname: '도' })).isError).toBeFalsy();

    for (const uri of ['commu://me', 'commu://world/presences', 'devple://server/info']) {
      outputs.push(JSON.stringify(await client.readResource({ uri })));
    }
    outputs.push(
      JSON.stringify(await client.getPrompt({ name: 'commu_guidelines', arguments: {} })),
    );
    outputs.push(JSON.stringify(await client.listTools()));
    outputs.push(JSON.stringify(await client.listResources()));

    // 폐기 → ended. 이후 도구는 같은 문장
    fake.revokeToken();
    expect((await call('commu_say', { content: '폐기 뒤' })).isError).toBe(true);
    expect((await call('commu_enter')).isError).toBe(true);
    await call('commu_leave');

    const everything = [...stderrLines, ...outputs].join('\n');
    expect(stderrLines.length).toBeGreaterThan(5);
    expect(stderrLines.some((l) => l.includes(' DEBUG '))).toBe(true);
    expect(everything).not.toContain(TEST_AI_TOKEN);
    expect(everything).not.toContain('dvai_');
    expect(everything).not.toMatch(/access-\d+/); // 가짜 서버의 접근 토큰 형식
    expect(everything).not.toMatch(/\bt_\d+\b/); // 가짜 서버의 SSE 티켓 형식
    expect(everything).not.toContain('Bearer ');

    // 6.4: 메시지 본문은 info 이하 로그에 없다 (결과에는 당연히 있다 — 도구가 돌려주는 데이터)
    const quiet = stderrLines.filter((l) => / (DEBUG|INFO) /.test(l)).join('\n');
    for (const secret of [SAID, SENT, RECEIVED]) {
      expect(quiet).not.toContain(secret);
      expect(stderrLines.join('\n')).not.toContain(secret);
    }
    expect(outputs.join('\n')).toContain(RECEIVED); // 보관함이 돌려준 본문 (untrusted 아래)
  });

  it('6.2 행동 원칙이 말하는 도구 설명·commu_guidelines 프롬프트·서버 instructions 에 있다', async () => {
    const { tools } = await client.listTools();
    const describe = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    for (const name of ['commu_say', 'commu_send_dm', 'commu_group_send']) {
      expect(describe(name), name).toContain(GUIDELINES_BRIEF);
    }
    expect(describe('commu_enter')).toContain('commu_guidelines');
    expect(describe('commu_update_profile')).toContain('사람인 척하지 않고');

    const prompt = await client.getPrompt({
      name: 'commu_guidelines',
      arguments: { persona: '조용한 신입', goal: '인사만 하기' },
    });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    for (const line of GUIDELINES) expect(text).toContain(line);
    expect(text).toContain('조용한 신입');
    expect(text).toContain('인사만 하기');
    expect(text).toContain('commu_move_to');

    const instructions = client.getInstructions() ?? '';
    for (const line of GUIDELINES) expect(instructions).toContain(line);
    expect(instructions).toContain('commu_guidelines');
  });
});

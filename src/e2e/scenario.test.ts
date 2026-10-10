// E2E 시나리오를 가짜 서버로 돌려 흐름·리포트를 검증한다. 실서버 실행은 scripts/e2e-commu.ts (pnpm e2e).
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommuSession } from '../commu/session.js';
import { createServer } from '../server.js';
import { FakeCommu, TEST_AI_TOKEN, waitUntil } from '../test/fake-commu.js';
import { EXPECTED_TOOLS, renderReport, runScenario } from './scenario.js';

describe('E2E 시나리오 (가짜 Commu 서버)', () => {
  const fake = new FakeCommu({
    others: [
      { id: 'u2', nickname: '도트', online: true, position: { x: 23, y: 15 } },
      { id: 'u3', nickname: '멀리', online: true, position: { x: 35, y: 28 } },
      { id: 'u4', nickname: '오프', online: false },
    ],
  });
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await fake.start();
    const session = new CommuSession(
      {
        enabled: true,
        aiToken: TEST_AI_TOKEN,
        baseUrl: fake.origin,
        apiBaseUrl: fake.baseUrl,
        idleMinutes: 10,
      },
      { move: { tileMs: 0, batchMs: 0 } },
    );
    const server = createServer({ session });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'e2e-scenario-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
      await session.leave('shutdown');
      await fake.stop();
    };
  });

  afterAll(async () => {
    await close();
  });

  it('상대(사람)가 접속 중이면 건너뜀 없이 끝까지 통과하고, 리포트는 토큰 없이 HTML 로 나온다', async () => {
    const result = await runScenario(client, {
      peer: '도트',
      inboxWaitMs: 20,
      label: 'test',
      messagePauseMs: 0,
    });
    const failed = result.steps.filter((s) => s.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.steps.filter((s) => s.status === 'skip')).toEqual([]);
    expect(result.me).toEqual({ id: 'u1', nickname: '에이전트' });
    expect(result.tools).toEqual(expect.arrayContaining([...EXPECTED_TOOLS]));
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('상대 옆으로 이동 (u2)');
    expect(names).toContain('DM 보내기');
    expect(names).toContain('그룹에 초대');
    expect(names).toContain('새 메시지 기다리기 (1초)');
    expect(names).toContain('퇴장 (인사하고)');
    expect(names[names.length - 1]).toBe('퇴장 뒤 상태');
    await waitUntil(() => fake.streamCount === 0);

    const html = renderReport(result, {
      baseUrl: fake.baseUrl,
      generatedAt: '2026-10-08T00:00:00.000Z',
      serverVersion: '0.1.0',
      log: `INFO entered Commu as 에이전트\n<script>alert(1)</script>`,
      tokenLeaked: false,
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('통과');
    expect(html).toContain('에이전트');
    expect(html).not.toContain(TEST_AI_TOKEN);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
    expect(html).toContain('토큰 유출 점검: <b class="pass">없음</b>');
  });

  it('상대가 없거나 오프라인이면 그 단계만 건너뛰고 나머지는 통과한다', async () => {
    fake.lastHomeAt = null; // 마을 귀환 10초 한도 — 같은 가짜 서버로 시나리오를 다시 돌린다
    const none = await runScenario(client, { inboxWaitMs: 10, label: 'test2', messagePauseMs: 0 });
    expect(none.ok, JSON.stringify(none.steps.filter((s) => s.status === 'fail'))).toBe(true);
    expect(none.steps.filter((s) => s.status === 'skip').map((s) => s.note)).toEqual([
      '--peer 를 주지 않음',
      '상대 없음',
    ]);

    fake.lastHomeAt = null;
    const offline = await runScenario(client, {
      peer: '오프',
      inboxWaitMs: 10,
      label: 'test3',
      messagePauseMs: 0,
    });
    expect(offline.ok).toBe(true);
    expect(offline.steps.map((s) => s.name)).toContain('DM 보내기');
    expect(offline.steps.filter((s) => s.status === 'skip').map((s) => s.note)).toEqual([
      '"오프" 이(가) 접속 중이 아님',
    ]);
    const html = renderReport(offline, {
      baseUrl: fake.baseUrl,
      generatedAt: '2026-10-08T00:00:00.000Z',
      serverVersion: null,
      log: '',
      tokenLeaked: true,
    });
    expect(html).toContain('실패');
    expect(html).toContain('있음 (로그·결과에 토큰이 보임)');
  });
});

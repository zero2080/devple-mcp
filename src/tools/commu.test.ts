import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommuSession } from '../commu/session.js';
import { createServer } from '../server.js';
import { FakeCommu, TEST_AI_TOKEN } from '../test/fake-commu.js';

type Structured = Record<string, unknown>;

describe('commu_* 도구 (MCP 클라이언트 → 서버 → 가짜 Commu)', () => {
  const fake = new FakeCommu({
    others: [
      { id: 'u2', nickname: '도트', online: true, position: { x: 23, y: 15 } },
      { id: 'u3', nickname: '멀리', online: true, position: { x: 35, y: 28 } },
    ],
  });
  let session: CommuSession;
  let client: Client;
  let close: () => Promise<void>;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: (result.structuredContent ?? {}) as Structured };
  };

  beforeAll(async () => {
    await fake.start();
    session = new CommuSession(
      {
        enabled: true,
        aiToken: TEST_AI_TOKEN,
        baseUrl: fake.origin,
        apiBaseUrl: fake.baseUrl,
        idleMinutes: 10,
      },
      { hopIntervalMs: 0, map: null },
    );
    const server = createServer({ session });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'commu-tools-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
      await session.disconnect();
      await fake.stop();
    };
  });

  afterAll(async () => {
    await close();
  });

  it('commu_* 도구 25개와 리소스·프롬프트가 등록돼 있다', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).filter((n) => n.startsWith('commu_'));
    expect(names).toHaveLength(25);
    expect(names).toEqual(
      expect.arrayContaining(['commu_connect', 'commu_say', 'commu_events', 'commu_move_to']),
    );
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['commu://me', 'commu://world/presences']),
    );
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('commu-participant');
  });

  it('commu_connect 와 commu_nearby', async () => {
    const connect = await call('commu_connect');
    expect(connect.result.isError).toBeFalsy();
    expect(connect.data).toMatchObject({
      state: 'connected',
      me: { nickname: '에이전트' },
      onlineCount: 3,
    });

    const nearby = await call('commu_nearby');
    expect(nearby.data['inRadius']).toEqual([
      expect.objectContaining({ nickname: '도트', distance: 3, inRadius: true }),
    ]);
    expect((nearby.data['outside'] as unknown[]).length).toBe(1);
  });

  it('commu_say 와 commu_events (waitMs 롱폴링)', async () => {
    const status = await call('commu_status');
    const cursor = status.data['latestEventCursor'] as number;

    const say = await call('commu_say', { content: '반가워요!' });
    expect(say.data).toMatchObject({ heardBy: ['도트'] });
    expect((say.data['message'] as Structured)['senderNickname']).toBe('에이전트');

    const events = await call('commu_events', {
      since: cursor,
      types: ['chat.public'],
      waitMs: 2000,
    });
    const list = events.data['events'] as Array<{ type: string; payload: Structured }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'chat.public', payload: { content: '반가워요!' } });
    expect(events.data['waited']).toBe(true);

    // 외부에서 들어온 DM 은 sender 가 간결한 형태로 바뀌어 온다
    const next = events.data['nextCursor'] as number;
    setTimeout(
      () =>
        fake.emit('chat.dm', {
          kind: 'dm',
          id: '900',
          conversationId: 'c_u2',
          senderId: 'u2',
          content: '안녕',
          links: [],
          createdAt: Date.now(),
          sender: fake.userOf({ id: 'u2', nickname: '도트', online: true }),
          peerId: 'u1',
        }),
      30,
    );
    const dm = await call('commu_events', { since: next, waitMs: 2000 });
    const dmEvents = dm.data['events'] as Array<{ type: string; payload: Structured }>;
    expect(dmEvents[0]).toMatchObject({
      type: 'chat.dm',
      payload: { senderNickname: '도트', peerId: 'u1' },
    });
    expect(dmEvents[0]!.payload).not.toHaveProperty('sender');
  });

  it('commu_move_to', async () => {
    const move = await call('commu_move_to', { x: 20, y: 21 });
    expect(move.data).toMatchObject({ reached: true, hops: 2, position: { x: 20, y: 21 } });
  });

  it('계약 에러는 isError 결과로 돌아온다', async () => {
    const self = await call('commu_dm_send', { userId: 'u1', content: '나에게' });
    expect(self.result.isError).toBe(true);
    const text = (self.result.content[0] as { text: string }).text;
    expect(text).toContain('VALIDATION_FAILED');
    expect(text).toContain('"userId":"invalid"');
  });

  it('DM·그룹 흐름', async () => {
    const sent = await call('commu_dm_send', { userId: 'u2', content: '따로 이야기해요' });
    expect((sent.data['message'] as Structured)['conversationId']).toBe('c_u2');
    const convs = await call('commu_dm_conversations');
    expect((convs.data['items'] as Structured[])[0]).toMatchObject({ peer: { nickname: '도트' } });
    const history = await call('commu_dm_history', { userId: 'u2' });
    expect((history.data['items'] as Structured[])[0]).toMatchObject({
      content: '따로 이야기해요',
    });

    const created = await call('commu_group_create', { name: '도트 모임' });
    const groupId = (created.data['group'] as Structured)['id'] as string;
    await call('commu_group_members', { groupId, action: 'invite', userId: 'u2' });
    const detail = await call('commu_group_detail', { groupId });
    expect((detail.data['members'] as Structured[]).map((m) => m['nickname'])).toEqual([
      '에이전트',
      '도트',
    ]);
    const msg = await call('commu_group_send', { groupId, content: '모임 시작!' });
    expect((msg.data['message'] as Structured)['groupId']).toBe(groupId);
    const groups = await call('commu_groups');
    expect((groups.data['items'] as Structured[])[0]).toMatchObject({
      name: '도트 모임',
      memberCount: 2,
    });
    const dissolve = await call('commu_group_update', { groupId, action: 'dissolve' });
    expect(dissolve.data).toEqual({ ok: true });
  });

  it('토큰이 없으면 서버는 뜨고 commu_* 도구는 안내 오류를 돌려준다 (MCP.md 2)', async () => {
    const disabled = new CommuSession(
      {
        enabled: false,
        aiToken: undefined,
        baseUrl: fake.origin,
        apiBaseUrl: fake.baseUrl,
        idleMinutes: 10,
      },
      { map: null },
    );
    const server = createServer({ session: disabled });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'disabled-test', version: '0.0.0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    try {
      const exchangesBefore = fake.exchangeCount;
      const status = await c.callTool({ name: 'commu_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toMatchObject({ state: 'disconnected' });
      const connect = await c.callTool({ name: 'commu_connect', arguments: {} });
      expect(connect.isError).toBe(true);
      expect((connect.content[0] as { text: string }).text).toContain('토큰이 설정되지 않았습니다');
      expect(fake.exchangeCount).toBe(exchangesBefore);
    } finally {
      await c.close();
      await server.close();
    }
  });

  it('리소스와 프롬프트', async () => {
    const presences = await client.readResource({ uri: 'commu://world/presences' });
    const parsed = JSON.parse((presences.contents[0] as { text: string }).text) as Structured;
    expect((parsed['presences'] as Structured[]).map((p) => p['nickname'])).toEqual([
      '도트',
      '멀리',
    ]);

    const prompt = await client.getPrompt({
      name: 'commu-participant',
      arguments: { goal: '인사하기' },
    });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('commu_connect');
    expect(text).toContain('인사하기');
  });
});

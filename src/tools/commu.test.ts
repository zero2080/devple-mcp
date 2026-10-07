import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommuSession } from '../commu/session.js';
import { createServer } from '../server.js';
import { FakeCommu, TEST_AI_TOKEN, waitUntil } from '../test/fake-commu.js';

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
  const config = () => ({
    enabled: true,
    aiToken: TEST_AI_TOKEN,
    baseUrl: fake.origin,
    apiBaseUrl: fake.baseUrl,
    idleMinutes: 10,
  });

  beforeAll(async () => {
    await fake.start();
    session = new CommuSession(config(), { hopIntervalMs: 0, map: null });
    const server = createServer({ session });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'commu-tools-test', version: '0.0.0' });
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

  it('수명 도구 3종이 있고 commu_events 는 없다 (C2 read_inbox 로 대체)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['commu_enter', 'commu_leave', 'commu_status']));
    expect(names).not.toContain('commu_connect');
    expect(names).not.toContain('commu_events');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('commu://world/presences');
  });

  it('commu_status 는 입장 없이 idle 을 보고하고, commu_enter 가 입장한다', async () => {
    const idle = await call('commu_status');
    expect(idle.data).toMatchObject({ state: 'idle', me: null, unread: { dm: 0, group: 0 } });
    expect(fake.calls.length).toBe(0);

    const enter = await call('commu_enter');
    expect(enter.result.isError).toBeFalsy();
    expect(enter.data).toMatchObject({
      me: { id: 'u1', nickname: '에이전트', kind: 'ai' },
      position: { x: 20, y: 15 },
      nearbyCount: 1,
      onlineCount: 3,
      proximityRadius: 5,
      maxMessageLength: 200,
    });
    const online = await call('commu_status');
    expect(online.data).toMatchObject({ state: 'online', sse: 'open', idle: { minutes: 10 } });
    expect((online.data['idle'] as Structured)['leaveInSec']).toBeGreaterThan(500);
  });

  it('commu_nearby 는 kind 를 포함해 반경 안·밖을 나눈다', async () => {
    const nearby = await call('commu_nearby');
    expect(nearby.data['inRadius']).toEqual([
      expect.objectContaining({ nickname: '도트', kind: 'human', distance: 3, inRadius: true }),
    ]);
    expect((nearby.data['outside'] as unknown[]).length).toBe(1);
  });

  it('commu_say 뒤 받은 DM 이 status.unread 에 잡힌다', async () => {
    const say = await call('commu_say', { content: '반가워요!' });
    expect(say.data).toMatchObject({ heardBy: ['도트'] });
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
    });
    await waitUntil(() => session.inbox.size === 1);
    const status = await call('commu_status');
    expect(status.data).toMatchObject({
      unread: { dm: 1, group: 0 },
      inbox: { size: 1, dropped: 0 },
    });
  });

  it('commu_move_to', async () => {
    const move = await call('commu_move_to', { x: 20, y: 21 });
    expect(move.data).toMatchObject({ reached: true, hops: 2, position: { x: 20, y: 21 } });
  });

  it('계약 에러는 MCP.md 7 문장 + 계약 JSON 으로 돌아온다', async () => {
    const self = await call('commu_dm_send', { userId: 'u1', content: '나에게' });
    expect(self.result.isError).toBe(true);
    const text = (self.result.content[0] as { text: string }).text;
    expect(text).toMatch(/^입력이 올바르지 않습니다 \(userId: invalid\)/);
    expect(text).toContain('"code":"VALIDATION_FAILED"');

    fake.rateLimitNextMessage(7);
    const limited = await call('commu_say', { content: '빨리' });
    expect(limited.result.isError).toBe(true);
    expect((limited.result.content[0] as { text: string }).text).toContain('7초 뒤에 다시 하세요');
    const status = await call('commu_status');
    expect(status.data['rateLimit']).toEqual({ retryAfterSec: 7 });
  });

  it('DM·그룹 흐름', async () => {
    const sent = await call('commu_dm_send', { userId: 'u2', content: '따로 이야기해요' });
    expect((sent.data['message'] as Structured)['conversationId']).toBe('c_u2');
    const convs = await call('commu_dm_conversations');
    expect((convs.data['items'] as Structured[])[0]).toMatchObject({
      peer: { nickname: '도트', kind: 'human' },
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
    const dissolve = await call('commu_group_update', { groupId, action: 'dissolve' });
    expect(dissolve.data).toEqual({ ok: true });
  });

  it('commu_leave 뒤 status 는 idle, 행동 도구는 자동 재입장한다', async () => {
    const leave = await call('commu_leave');
    expect(leave.data).toEqual({ left: true });
    expect((await call('commu_status')).data).toMatchObject({ state: 'idle' });
    await waitUntil(() => fake.streamCount === 0);
    const say = await call('commu_say', { content: '다시 왔어요' });
    expect(say.result.isError).toBeFalsy();
    expect((await call('commu_status')).data).toMatchObject({ state: 'online' });
  });

  it('토큰이 없으면 서버는 뜨고 commu_* 도구는 안내 오류를 돌려준다 (MCP.md 2)', async () => {
    const disabled = new CommuSession(
      { ...config(), enabled: false, aiToken: undefined },
      { map: null },
    );
    const server = createServer({ session: disabled });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'disabled-test', version: '0.0.0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    try {
      const exchangesBefore = fake.exchangeCount;
      const status = await c.callTool({ name: 'commu_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({ state: 'idle' });
      const enter = await c.callTool({ name: 'commu_enter', arguments: {} });
      expect(enter.isError).toBe(true);
      expect((enter.content[0] as { text: string }).text).toContain('토큰이 설정되지 않았습니다');
      const say = await c.callTool({ name: 'commu_say', arguments: { content: 'x' } });
      expect(say.isError).toBe(true);
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
    expect((prompt.messages[0]?.content as { text: string }).text).toContain('인사하기');
  });
});

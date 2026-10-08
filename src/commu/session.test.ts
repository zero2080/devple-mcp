import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FakeCommu, SPAWN, TEST_AI_TOKEN, waitUntil } from '../test/fake-commu.js';
import { ManualClock } from './clock.js';
import type { CommuConfig } from './config.js';
import { CommuApiError, CommuEndedError } from './errors.js';
import type { MapGrid } from './map.js';
import { CommuSession } from './session.js';

function openGrid(): MapGrid {
  return { id: 'main', width: 40, height: 30, spawn: SPAWN, collision: new Array(1200).fill(0) };
}

const dmFrom = (fake: FakeCommu, id: string, content: string) => ({
  kind: 'dm',
  id,
  conversationId: 'c_u2',
  senderId: 'u2',
  content,
  links: [],
  createdAt: Date.now(),
  sender: fake.userOf({ id: 'u2', nickname: '도트', online: true }),
  peerId: 'u1',
});

describe('CommuSession (MCP.md 3 수명 · 4 보관함, 가짜 Commu 서버)', () => {
  const fake = new FakeCommu({
    others: [
      { id: 'u2', nickname: '도트', online: true, position: { x: 23, y: 15 } },
      { id: 'u3', nickname: '멀리', online: true, position: { x: 35, y: 28 } },
      { id: 'u4', nickname: '오프', online: false },
      { id: 'u5', nickname: '정지', online: false, status: 'suspended' },
    ],
  });
  let config: CommuConfig;
  const sessions: CommuSession[] = [];

  const newSession = (deps: ConstructorParameters<typeof CommuSession>[1] = {}) => {
    const session = new CommuSession(config, {
      move: { tileMs: 0, batchMs: 0 },
      map: openGrid(),
      ...deps,
    });
    sessions.push(session);
    return session;
  };
  const paths = (p: string) => fake.calls.filter((c) => c.path === p);
  const positionBodies = (since: number) =>
    fake.calls
      .slice(since)
      .filter((c) => c.method === 'PUT' && c.path === '/me/position')
      .map((c) => c.body as { x: number; y: number; dir: string; seq: number });

  beforeAll(async () => {
    await fake.start();
    config = {
      enabled: true,
      aiToken: TEST_AI_TOKEN,
      baseUrl: fake.origin,
      apiBaseUrl: fake.baseUrl,
      idleMinutes: 10,
    };
  });

  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.leave('shutdown');
    fake.myPosition = { mapId: 'main', ...SPAWN, dir: 'down' };
    fake.suspended = false;
    fake.revoked = false;
  });

  afterAll(async () => {
    await fake.stop();
  });

  it('enter: 토큰 교환 → SSE → 스냅샷 → online, 상태를 보고한다', async () => {
    const session = newSession();
    expect(session.state).toBe('idle');
    const status = await session.enter();
    expect(session.state).toBe('online');
    expect(status).toMatchObject({
      state: 'online',
      me: { id: 'u1', nickname: '에이전트', kind: 'ai' },
      position: SPAWN,
      onlineCount: 3,
      nearbyCount: 1,
      proximityRadius: 5,
      unread: { dm: 0, group: 0 },
      inbox: { size: 0, dropped: 0 },
      rateLimit: null,
      idle: { minutes: 10 },
    });
    expect(status.idle.leaveInSec).toBeGreaterThan(590);
    expect(fake.calls.map((c) => c.path)).toEqual(['/auth/ai-token', '/sse/ticket', '/sse']);
    expect(session.world.nearby(5)[0]).toMatchObject({
      nickname: '도트',
      kind: 'human',
      distance: 3,
      inRadius: true,
    });

    const before = fake.calls.length;
    await session.enter();
    expect(fake.calls.length).toBe(before);
  });

  it('동시에 세 번 ensureOnline 해도 토큰 교환·SSE 연결은 한 번씩이다', async () => {
    const session = newSession();
    const exchanges = fake.exchangeCount;
    const sse = paths('/sse').length;
    await Promise.all([session.ensureOnline(), session.ensureOnline(), session.enter()]);
    expect(session.state).toBe('online');
    expect(fake.exchangeCount).toBe(exchanges + 1);
    expect(paths('/sse').length).toBe(sse + 1);
  });

  it('leave 는 SSE 만 닫고 idle 이 되며, 다음 행동 도구가 토큰을 재사용해 자동 재입장한다', async () => {
    const session = newSession();
    await session.enter();
    const exchanges = fake.exchangeCount;
    const sse = paths('/sse').length;
    await session.leave();
    expect(session.state).toBe('idle');
    await waitUntil(() => fake.streamCount === 0);
    expect(session.world.size).toBe(0);
    await session.leave(); // 멱등

    const { heardBy } = await session.say('다시 왔어요');
    expect(session.state).toBe('online');
    expect(heardBy.map((p) => p.nickname)).toEqual(['도트']);
    expect(fake.exchangeCount).toBe(exchanges);
    expect(paths('/sse').length).toBe(sse + 1);
  });

  it('도구 호출이 없으면 유휴 시간 뒤 자동 퇴장하고, touch 가 타이머를 리셋한다 (MCP.md 3.3)', async () => {
    const clock = new ManualClock();
    const session = newSession({ clock });
    await session.enter();
    await clock.advance(9 * 60_000);
    session.touch();
    await clock.advance(9 * 60_000);
    expect(session.state).toBe('online');
    expect(session.status().idle.leaveInSec).toBe(60);
    await clock.advance(61_000);
    await waitUntil(() => session.state === 'idle');
    await waitUntil(() => fake.streamCount === 0);
    expect(session.status().idle.leaveInSec).toBeNull();
    // 다음 행동 도구에서 자동 재입장
    await session.say('돌아왔어요');
    expect(session.state).toBe('online');
  });

  it('SSE 가 끊기면 새 티켓·lastEventId 로 재연결하고, 끊긴 사이 이벤트를 재전송으로 받는다', async () => {
    const session = newSession({ sse: { backoff: { initialMs: 10, maxMs: 10, jitter: 0 } } });
    await session.enter();
    const lastEventId = session.status().lastEventId;
    const tickets = paths('/sse/ticket').length;
    const streams = paths('/sse').length;
    fake.dropStreams();
    fake.emit('system.notice', {
      id: 'n1',
      content: '끊긴 사이 공지',
      createdBy: 'admin',
      createdAt: Date.now(),
    });
    await waitUntil(() => paths('/sse').length === streams + 1 && fake.streamCount === 1, 3000);
    await waitUntil(() => session.status().sse === 'open', 3000);
    expect(paths('/sse/ticket').length).toBe(tickets + 1);
    expect(paths('/sse').at(-1)?.query['lastEventId']).toBe(lastEventId);
    await waitUntil(() => session.inbox.size === 1);
    expect(session.inbox.read().items[0]).toMatchObject({
      type: 'notice',
      untrusted: { content: '끊긴 사이 공지' },
    });
    expect(session.state).toBe('online');
  });

  it('보관함: 남의 DM·근접 대화는 쌓이고 내 에코는 빠지며, 안 읽음 수가 status 에 보인다', async () => {
    const session = newSession();
    await session.enter();
    await session.say('안녕하세요');
    fake.emit('chat.dm', dmFrom(fake, '900', '안녕'));
    await waitUntil(() => session.inbox.size === 1);
    expect(session.status().unread).toEqual({ dm: 1, group: 0 });
    const page = session.inbox.read();
    expect(page.items[0]).toMatchObject({
      type: 'dm',
      from: { userId: 'u2', nickname: '도트', kind: 'human' },
      untrusted: { content: '안녕' },
    });
    expect(session.status().unread).toEqual({ dm: 0, group: 0 });
    expect(session.inbox.recentPublic()).toEqual([]); // 내 발화는 보관하지 않는다
  });

  it('moveTo: A* 경로로 걸어 도착하고, 요청마다 3칸 이내·seq 증가, 점유된 목적지는 직전 칸에서 그쪽을 본다', async () => {
    const session = newSession();
    await session.enter();
    const since = fake.calls.length;
    const result = await session.moveTo({ x: 20, y: 24 });
    expect(result).toMatchObject({
      status: 'arrived',
      tilesMoved: 9,
      remainingTiles: 0,
      rejections: 0,
      position: { x: 20, y: 24, dir: 'down' },
    });
    expect(session.status().position).toEqual({ mapId: 'main', x: 20, y: 24, dir: 'down' });
    const bodies = positionBodies(since);
    expect(bodies).toHaveLength(result.requests);
    for (let i = 1; i < bodies.length; i++)
      expect(bodies[i]!.seq).toBeGreaterThan(bodies[i - 1]!.seq);

    const beside = await session.moveTo({ x: 23, y: 15 }); // u2 가 서 있다
    expect(beside).toMatchObject({
      status: 'arrived',
      goal: { x: 22, y: 15 },
      position: { x: 22, y: 15, dir: 'right' },
      remainingTiles: 0,
    });
    expect(session.status().moving).toBe(false);
  });

  it('moveTo({ userId }): 그 사람 옆 빈 칸으로 가서 바라본다. 이미 옆이면 요청 없이 arrived, 없는 사람·오프라인·나 자신은 오류', async () => {
    const session = newSession();
    await session.enter();
    const result = await session.moveTo({ userId: 'u2' });
    expect(result).toMatchObject({
      status: 'arrived',
      goal: { x: 22, y: 15 },
      position: { x: 22, y: 15, dir: 'right' },
      user: { userId: 'u2', distance: 1, withinProximity: true },
    });
    const since = fake.calls.length;
    expect(await session.moveTo({ userId: 'u2' })).toMatchObject({
      status: 'arrived',
      requests: 0,
    });
    expect(positionBodies(since)).toHaveLength(0);
    await expect(session.moveTo({ userId: 'nobody' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { resource: 'user' },
    });
    expect(await session.moveTo({ userId: 'u4' })).toMatchObject({
      status: 'blocked',
      reason: 'user_offline',
      requests: 0,
    });
    await expect(session.moveTo({ userId: 'u1' })).rejects.toThrow(/자기 자신/);
  });

  it('moveTo: 벽 목적지는 blocked(collision), 월드가 모르는 끼어든 사람은 409 occupied 로 돌아가고, 재계산을 다 쓰면 blocked', async () => {
    const wall = openGrid();
    wall.collision[15 * 40 + 25] = 1;
    const walled = newSession({ map: wall });
    await walled.enter();
    expect(await walled.moveTo({ x: 25, y: 15 })).toMatchObject({
      status: 'blocked',
      reason: 'collision',
      requests: 0,
    });
    await walled.leave();

    const session = newSession();
    await session.enter();
    fake.others.set('u6', {
      id: 'u6',
      nickname: '끼어듦',
      online: true,
      position: { x: 20, y: 18 },
    });
    try {
      const result = await session.moveTo({ x: 20, y: 21 });
      expect(result).toMatchObject({
        status: 'arrived',
        position: { x: 20, y: 21 },
        rejections: 1,
        replans: 1,
      });
    } finally {
      fake.others.delete('u6');
    }
    fake.rejectPositions('too_far', 4);
    expect(await session.moveTo({ x: 20, y: 15 })).toMatchObject({
      status: 'blocked',
      reason: 'too_far',
      rejections: 4,
      replans: 3,
      tilesMoved: 0,
      position: { x: 20, y: 21 },
    });
  });

  it('이동 중에는 다른 행동 도구가 끝날 때까지 기다리고(status.moving), 이동끼리는 차례로 간다', async () => {
    const session = newSession();
    await session.enter();
    const since = fake.calls.length;
    const move = session.moveTo({ x: 20, y: 20 });
    expect(session.status().moving).toBe(true);
    const say = session.say('가는 중');
    const next = session.moveTo({ x: 22, y: 20 });
    const [moved, said, moved2] = await Promise.all([move, say, next]);
    expect(moved).toMatchObject({ status: 'arrived', position: { x: 20, y: 20 } });
    expect(moved2).toMatchObject({ status: 'arrived', position: { x: 22, y: 20 } });
    expect(said.message.position).toEqual({ mapId: 'main', x: 20, y: 20, dir: 'down' });
    const order = fake.calls.slice(since).map((c) => `${c.method} ${c.path}`);
    const firstSay = order.indexOf('POST /chat/public');
    const lastBeforeSay = order.slice(0, firstSay).filter((o) => o === 'PUT /me/position');
    expect(lastBeforeSay).toHaveLength(moved.requests);
    expect(session.status().moving).toBe(false);
  });

  it('접근 토큰은 expiresIn 의 80% 가 지나면 다시 교환하고, 401 AUTH_REQUIRED 면 한 번 재교환한다', async () => {
    const clock = new ManualClock();
    const session = newSession({ clock });
    await session.enter();
    const before = fake.exchangeCount;
    await clock.advance(0.79 * 900_000);
    await session.client.getMe();
    expect(fake.exchangeCount).toBe(before);
    await clock.advance(0.02 * 900_000);
    await session.client.getMe();
    expect(fake.exchangeCount).toBe(before + 1);
    fake.expireAccessToken();
    const { me } = await session.client.getMe();
    expect(me.kind).toBe('ai');
    expect(fake.exchangeCount).toBe(before + 2);
  });

  it('토큰 폐기 → ended(revoked), 정지 → ended(suspended). 이후 입장은 같은 오류 (MCP.md 3.4)', async () => {
    const revoked = newSession();
    await revoked.enter();
    fake.revokeToken();
    await expect(revoked.client.getMe()).rejects.toMatchObject({ reason: 'revoked' });
    expect(revoked.status()).toMatchObject({ state: 'ended', endedReason: 'revoked' });
    await expect(revoked.enter()).rejects.toBeInstanceOf(CommuEndedError);
    await revoked.leave();
    expect(revoked.state).toBe('ended');
    fake.revoked = false;

    const suspended = newSession();
    await suspended.enter();
    fake.suspend();
    await waitUntil(() => suspended.state === 'ended');
    expect(suspended.status().endedReason).toBe('suspended');
    expect(suspended.status().idle.leaveInSec).toBeNull();
    await expect(suspended.enter()).rejects.toMatchObject({ reason: 'suspended' });
  });

  it('토큰이 없으면 disabled, 틀리면 revoked 로 끝난다', async () => {
    const disabled = new CommuSession({ ...config, enabled: false, aiToken: undefined });
    await expect(disabled.enter()).rejects.toThrow(/토큰이 설정되지 않았습니다/);
    expect(disabled.status().state).toBe('idle');
    const wrong = new CommuSession({ ...config, aiToken: 'dvai_wrong' });
    await expect(wrong.enter()).rejects.toMatchObject({ reason: 'revoked' });
    expect(wrong.state).toBe('ended');
  });

  it('429 는 재시도 없이 올라오고 status.rateLimit 에 남은 시간이 보인다 (MCP.md 6.3)', async () => {
    const clock = new ManualClock();
    const session = newSession({ clock });
    await session.enter();
    const before = paths('/chat/public').length;
    fake.rateLimitNextMessage(5);
    await expect(session.say('빠르게')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSec: 5,
    });
    expect(paths('/chat/public')).toHaveLength(before + 1);
    expect(session.status().rateLimit).toEqual({ retryAfterSec: 5 });
    await clock.advance(6_000);
    expect(session.status().rateLimit).toBeNull();
  });

  it('계약 에러는 CommuApiError 로 올라온다', async () => {
    const session = newSession();
    await session.enter();
    await expect(session.client.sendDm('u1', '나에게')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { fields: { userId: 'invalid' } },
    });
    await expect(session.client.sendDm('u5', '정지 회원에게')).rejects.toBeInstanceOf(
      CommuApiError,
    );
  });

  it('sync.required 와 presence.* 가 월드에 반영된다', async () => {
    const session = newSession();
    await session.enter();
    fake.others.set('u6', {
      id: 'u6',
      nickname: '새사람',
      online: true,
      position: { x: 10, y: 10 },
    });
    fake.emit('sync.required', { reason: 'server_restart' });
    await waitUntil(() => session.world.size === 4);
    fake.others.delete('u6');
    fake.emit(
      'presence.joined',
      fake.presenceOf({ id: 'u7', nickname: '손님', online: true, position: { x: 1, y: 1 } }),
    );
    await waitUntil(() => session.world.size === 5);
    fake.emit('presence.updated', { userId: 'u7', state: 'away' });
    await waitUntil(() => session.world.others().find((p) => p.userId === 'u7')?.state === 'away');
    fake.emit('presence.left', { userId: 'u7' });
    await waitUntil(() => session.world.size === 4);
    expect(session.inbox.size).toBe(0); // presence·sync 는 보관함에 없다
  });
});

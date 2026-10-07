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

describe('CommuSession (가짜 Commu 서버)', () => {
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
    const session = new CommuSession(config, { hopIntervalMs: 0, map: null, ...deps });
    sessions.push(session);
    return session;
  };

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
    for (const s of sessions.splice(0)) await s.disconnect();
    fake.myPosition = { mapId: 'main', ...SPAWN, dir: 'down' };
    fake.suspended = false;
    fake.revoked = false;
  });

  afterAll(async () => {
    await fake.stop();
  });

  it('토큰 교환 → SSE → 스냅샷까지 연결하고 상태를 보고한다', async () => {
    const session = newSession();
    const status = await session.connect();
    expect(status.state).toBe('connected');
    expect(status.me).toMatchObject({ id: 'u1', nickname: '에이전트' });
    expect(status.position).toMatchObject(SPAWN);
    expect(status.onlineCount).toBe(3);
    expect(status.nearbyCount).toBe(1);
    expect(status.proximityRadius).toBe(5);
    expect(fake.calls.map((c) => c.path)).toEqual(['/auth/ai-token', '/sse/ticket', '/sse']);

    const nearby = session.world.nearby(5);
    expect(nearby[0]).toMatchObject({ nickname: '도트', distance: 3, inRadius: true });
    expect(nearby[1]).toMatchObject({ nickname: '멀리', inRadius: false });

    // 두 번째 connect 는 아무것도 하지 않는다
    const before = fake.calls.length;
    await session.connect();
    expect(fake.calls.length).toBe(before);
  });

  it('근접 발화는 반경 안 사람을 heardBy 로 알려 주고 이벤트 버퍼에도 들어온다', async () => {
    const session = newSession();
    await session.connect();
    const cursor = session.events.latestCursor;
    const { message, heardBy } = await session.say('안녕하세요 https://devple.net');
    expect(message.kind).toBe('public');
    expect(message.links).toEqual(['https://devple.net']);
    expect(heardBy).toEqual(['도트']);
    await expect(session.events.waitFor(cursor, ['chat.public'], 2000)).resolves.toBe(true);
    const page = session.events.since(cursor, { types: ['chat.public'] });
    expect(page.events[0]?.payload).toMatchObject({
      senderId: 'u1',
      content: '안녕하세요 https://devple.net',
    });
  });

  it('맵 없이 직선 이동: 3칸씩 끊어 가고, 점유된 타일은 서버 409 로 멈춘다', async () => {
    const session = newSession();
    await session.connect();
    const result = await session.moveTo({ x: 20, y: 24 });
    expect(result.reached).toBe(true);
    expect(result.hops).toBe(3);
    expect(result.position).toMatchObject({ x: 20, y: 24, dir: 'down' });
    expect(session.world.me()?.position).toMatchObject({ x: 20, y: 24 });

    // (20,24) → (23,21) → (23,18) → (23,15): 마지막 칸에 도트가 서 있음
    const blocked = await session.moveTo({ x: 23, y: 15 });
    expect(blocked.reached).toBe(false);
    expect(blocked.hops).toBe(2);
    expect(blocked.stoppedBecause).toBe('occupied');
    expect(blocked.rejections).toEqual([{ x: 23, y: 15, reason: 'occupied' }]);
    expect(blocked.position).toMatchObject({ x: 23, y: 18 });
  });

  it('맵이 있으면 경로를 찾고, 점유된 목적지는 직전 타일에서 멈춘다', async () => {
    const session = newSession({ map: openGrid() });
    await session.connect();
    const result = await session.moveTo({ x: 23, y: 15 });
    expect(result.reached).toBe(false);
    expect(result.distanceToTarget).toBe(1);
    expect(result.rejections).toEqual([]);
    expect(result.position).toMatchObject({ x: 22, y: 15 });
    expect(result.pathLength).toBe(2);

    const wall = openGrid();
    wall.collision[15 * 40 + 25] = 1;
    const session2 = newSession({ map: wall });
    await session2.connect();
    const blocked = await session2.moveTo({ x: 25, y: 15 });
    expect(blocked.stoppedBecause).toBe('collision');
    expect(blocked.hops).toBe(0);
  });

  it('접근 토큰은 expiresIn 의 80% 가 지나면 다시 교환한다 (MCP.md 3.2)', async () => {
    const clock = new ManualClock();
    const session = newSession({ clock });
    await session.connect();
    const before = fake.exchangeCount;
    await clock.advance(0.79 * 900_000);
    await session.client.getMe();
    expect(fake.exchangeCount).toBe(before);
    await clock.advance(0.02 * 900_000);
    await session.client.getMe();
    expect(fake.exchangeCount).toBe(before + 1);
    const lastMe = fake.calls.filter((c) => c.path === '/me').at(-1);
    expect(lastMe?.headers.authorization).toBe(`Bearer ${fake.accessToken}`);
  });

  it('서버가 401 AUTH_REQUIRED 를 주면 한 번 재교환하고 재시도한다', async () => {
    const session = newSession();
    await session.connect();
    const before = fake.exchangeCount;
    fake.expireAccessToken();
    const { me } = await session.client.getMe();
    expect(me.id).toBe('u1');
    expect(fake.exchangeCount).toBe(before + 1);
  });

  it('토큰이 폐기되면 ended(revoked) 가 되고 복구하지 않는다 (MCP.md 3.4)', async () => {
    const session = newSession();
    await session.connect();
    fake.revokeToken();
    await expect(session.client.getMe()).rejects.toMatchObject({ reason: 'revoked' });
    expect(session.status().endedReason).toBe('revoked');
    await expect(session.connect()).rejects.toBeInstanceOf(CommuEndedError);
  });

  it('system.suspended 를 받으면 ended(suspended) 가 된다', async () => {
    const session = newSession();
    await session.connect();
    fake.suspend();
    await waitUntil(() => session.state === 'ended');
    expect(session.status().endedReason).toBe('suspended');
    await expect(session.connect()).rejects.toMatchObject({ reason: 'suspended' });
  });

  it('계약 에러는 CommuApiError 로 올라온다', async () => {
    const session = newSession();
    await session.connect();
    await expect(session.client.sendDm('u1', '나에게')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { fields: { userId: 'invalid' } },
    });
    await expect(session.client.sendDm('u5', '정지 회원에게')).rejects.toBeInstanceOf(
      CommuApiError,
    );
    await expect(session.client.getUser('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('sync.required 를 받으면 접속자 목록을 다시 받아 월드를 맞춘다', async () => {
    const session = newSession();
    await session.connect();
    fake.others.set('u6', {
      id: 'u6',
      nickname: '새사람',
      online: true,
      position: { x: 10, y: 10 },
    });
    fake.emit('sync.required', { reason: 'server_restart' });
    await waitUntil(() => fake.calls.some((c) => c.path === '/world/main/presences'));
    await waitUntil(() => session.world.size === 4);
    expect(session.world.others().map((p) => p.nickname)).toContain('새사람');
    fake.others.delete('u6');
  });

  it('presence.* 이벤트가 월드에 반영된다', async () => {
    const session = newSession();
    await session.connect();
    fake.emit(
      'presence.joined',
      fake.presenceOf({ id: 'u7', nickname: '손님', online: true, position: { x: 1, y: 1 } }),
    );
    await waitUntil(() => session.world.size === 4);
    fake.emit('presence.updated', { userId: 'u7', state: 'away', nickname: '손님2' });
    await waitUntil(() => session.world.others().find((p) => p.userId === 'u7')?.state === 'away');
    expect(session.world.others().find((p) => p.userId === 'u7')?.nickname).toBe('손님2');
    fake.emit('world.positions', {
      mapId: 'main',
      positions: [{ userId: 'u7', x: 2, y: 2, dir: 'up' }],
    });
    await waitUntil(() => session.world.others().find((p) => p.userId === 'u7')?.position.x === 2);
    fake.emit('presence.left', { userId: 'u7' });
    await waitUntil(() => session.world.size === 3);
    // positions·heartbeat 는 버퍼에 없다
    expect(session.events.since(0).events.map((e) => e.type)).not.toContain('world.positions');
  });

  it('disconnect 는 SSE 만 닫고, 다시 입장할 때 접근 토큰을 재사용한다', async () => {
    const session = newSession();
    await session.connect();
    expect(fake.streamCount).toBe(1);
    const exchanges = fake.exchangeCount;
    await session.disconnect();
    expect(session.state).toBe('disconnected');
    await waitUntil(() => fake.streamCount === 0);
    expect(session.world.size).toBe(0);
    await session.connect();
    expect(fake.exchangeCount).toBe(exchanges);
    expect(fake.streamCount).toBe(1);
  });

  it('토큰이 없으면 disabled, 틀리면 revoked 로 끝난다', async () => {
    const disabled = new CommuSession(
      { ...config, enabled: false, aiToken: undefined },
      { map: null },
    );
    await expect(disabled.connect()).rejects.toThrow(/토큰이 설정되지 않았습니다/);
    const wrong = new CommuSession({ ...config, aiToken: 'dvai_wrong' }, { map: null });
    await expect(wrong.connect()).rejects.toMatchObject({ reason: 'revoked' });
    expect(wrong.state).toBe('ended');
  });

  it('429 는 재시도 없이 Retry-After 와 함께 올라온다 (MCP.md 6.3)', async () => {
    const session = newSession();
    await session.connect();
    const before = fake.calls.filter((c) => c.path === '/chat/public').length;
    fake.rateLimitNextMessage(5);
    await expect(session.say('빠르게')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSec: 5,
    });
    expect(fake.calls.filter((c) => c.path === '/chat/public')).toHaveLength(before + 1);
  });
});

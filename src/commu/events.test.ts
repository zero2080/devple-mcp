import { describe, expect, it } from 'vitest';

import { EventBuffer } from './events.js';

const env = (id: number, type: string) => ({ id: String(id), type, ts: id, payload: { id } });

describe('EventBuffer', () => {
  it('커서 이후를 limit 만큼 돌려주고 hasMore·nextCursor 를 맞춘다', () => {
    const buf = new EventBuffer(100, () => 0);
    for (let i = 1; i <= 5; i++) buf.push(env(i, 'chat.public'));
    const page = buf.since(0, { limit: 2 });
    expect(page.events.map((e) => e.id)).toEqual(['1', '2']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(2);
    const rest = buf.since(page.nextCursor);
    expect(rest.events.map((e) => e.id)).toEqual(['3', '4', '5']);
    expect(rest.hasMore).toBe(false);
    expect(rest.nextCursor).toBe(5);
  });

  it('since 없이 부르면 최근 꼬리를 주고, 타입 필터와 미버퍼 타입을 지킨다', () => {
    const buf = new EventBuffer(100, () => 0);
    buf.push(env(1, 'chat.public'));
    buf.push(env(2, 'world.positions'));
    buf.push(env(3, 'system.heartbeat'));
    buf.push(env(4, 'chat.dm'));
    expect(buf.size).toBe(2);
    expect(buf.since(undefined, { limit: 1 }).events.map((e) => e.id)).toEqual(['4']);
    expect(buf.since(0, { types: ['chat.dm'] }).events.map((e) => e.id)).toEqual(['4']);
  });

  it('용량을 넘기면 오래된 것이 밀리고 dropped 로 알린다', () => {
    const buf = new EventBuffer(3, () => 0);
    for (let i = 1; i <= 5; i++) buf.push(env(i, 'chat.public'));
    const page = buf.since(0);
    expect(page.dropped).toBe(true);
    expect(page.events.map((e) => e.cursor)).toEqual([3, 4, 5]);
    expect(buf.since(2).dropped).toBe(false);
  });

  it('waitFor 는 새 이벤트가 오면 true, 시간이 지나면 false', async () => {
    const buf = new EventBuffer();
    const cursor = buf.latestCursor;
    const pending = buf.waitFor(cursor, ['chat.dm'], 1000);
    buf.push(env(1, 'chat.public')); // 타입이 달라 깨우지 않음
    buf.push(env(2, 'chat.dm'));
    await expect(pending).resolves.toBe(true);
    await expect(buf.waitFor(buf.latestCursor, undefined, 20)).resolves.toBe(false);
  });
});

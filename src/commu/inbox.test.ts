import { describe, expect, it } from 'vitest';

import { defaultAppearance } from '../test/fake-commu.js';
import { Inbox } from './inbox.js';
import type { User } from './schemas.js';

const user = (id: string, nickname: string, kind: 'human' | 'ai' = 'human'): User => ({
  id,
  nickname,
  appearance: defaultAppearance,
  kind,
  role: 'member',
  status: 'active',
  createdAt: 1,
});
const env = (id: number, type: string, payload: unknown) => ({
  id: String(id),
  type,
  ts: id,
  payload,
});
const msg = (id: string, senderId: string, content: string) => ({
  id,
  senderId,
  content,
  links: [],
  createdAt: 1,
});

describe('Inbox (MCP.md 4)', () => {
  it('근접 대화·DM·그룹·공지를 항목으로 바꾸고 다른 사용자 글은 untrusted 아래에만 둔다', () => {
    const inbox = new Inbox({
      now: () => 0,
      resolveKind: (id) => (id === 'u2' ? 'ai' : undefined),
    });
    inbox.myUserId = 'u1';
    inbox.ingest(
      env(1, 'chat.public', {
        ...msg('m1', 'u2', '안녕'),
        kind: 'public',
        position: { mapId: 'main', x: 1, y: 2, dir: 'down' },
        sender: { nickname: '도트' },
      }),
    );
    inbox.ingest(
      env(2, 'chat.dm', {
        ...msg('m2', 'u3', '디엠'),
        kind: 'dm',
        conversationId: 'c_u3',
        sender: user('u3', '멀리'),
        peerId: 'u1',
      }),
    );
    inbox.ingest(
      env(3, 'system.notice', { id: 'n1', content: '공지', createdBy: 'admin', createdAt: 3 }),
    );
    inbox.ingest(env(4, 'group.removed', { groupId: 'g1', reason: 'kicked' }));

    const page = inbox.read();
    expect(page.items.map((i) => i.type)).toEqual(['public', 'dm', 'notice', 'group_change']);
    expect(page.items[0]).toMatchObject({
      from: { userId: 'u2', nickname: '도트', kind: 'ai' },
      position: { x: 1, y: 2 },
      untrusted: { content: '안녕' },
    });
    expect(page.items[0]).not.toHaveProperty('content');
    expect(page.items[1]).toMatchObject({
      from: { kind: 'human' },
      conversationId: 'c_u3',
      untrusted: { content: '디엠' },
    });
    expect(page.items[3]).toMatchObject({ change: 'removed', reason: 'kicked' });
    expect(page.nextCursor).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it('내 에코·버퍼 밖 타입·중복 이벤트는 넣지 않는다', () => {
    const inbox = new Inbox();
    inbox.myUserId = 'u1';
    expect(
      inbox.ingest(
        env(1, 'chat.public', {
          ...msg('m1', 'u1', '내 말'),
          kind: 'public',
          position: { mapId: 'main', x: 0, y: 0, dir: 'up' },
          sender: { nickname: '나' },
        }),
      ),
    ).toBeNull();
    expect(inbox.ingest(env(2, 'world.positions', { mapId: 'main', positions: [] }))).toBeNull();
    expect(inbox.ingest(env(3, 'system.heartbeat', { serverTime: 1 }))).toBeNull();
    const notice = { id: 'n1', content: 'x', createdBy: 'a', createdAt: 1 };
    expect(inbox.ingest(env(4, 'system.notice', notice))).not.toBeNull();
    expect(inbox.ingest(env(4, 'system.notice', notice))).toBeNull(); // 재전송 중복
    expect(inbox.size).toBe(1);
  });

  it('read 는 since 이후를 limit 만큼 주고 delivered 로 표시한다 — 안 읽음 수에 반영', () => {
    const inbox = new Inbox();
    inbox.myUserId = 'u1';
    for (let i = 1; i <= 5; i++) {
      inbox.ingest(
        env(i, 'chat.dm', {
          ...msg(`m${i}`, 'u2', `d${i}`),
          kind: 'dm',
          conversationId: 'c_u2',
          sender: user('u2', '도트'),
          peerId: 'u1',
        }),
      );
    }
    inbox.ingest(
      env(6, 'chat.group', {
        ...msg('g1', 'u2', 'gg'),
        kind: 'group',
        groupId: 'g',
        sender: user('u2', '도트'),
      }),
    );
    expect(inbox.unread()).toEqual({ dm: 5, group: 1 });
    const first = inbox.read(0, 2);
    expect(first.items.map((i) => i.cursor)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    expect(inbox.unread()).toEqual({ dm: 3, group: 1 });
    const rest = inbox.read(first.nextCursor, 50);
    expect(rest.items).toHaveLength(4);
    expect(inbox.unread()).toEqual({ dm: 0, group: 0 });
    expect(inbox.read(rest.nextCursor).items).toEqual([]);
  });

  it('용량을 넘으면 오래된 것부터 버리고 dropped 를 센다', () => {
    const inbox = new Inbox({ capacity: 3 });
    for (let i = 1; i <= 5; i++) {
      inbox.ingest(
        env(i, 'system.notice', { id: `n${i}`, content: 'x', createdBy: 'a', createdAt: i }),
      );
    }
    const page = inbox.read();
    expect(page.items.map((i) => i.cursor)).toEqual([3, 4, 5]);
    expect(page.dropped).toBe(2);
    expect(inbox.recentPublic()).toEqual([]);
  });
});

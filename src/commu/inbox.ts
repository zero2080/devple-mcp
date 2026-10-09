// 보관함 (MCP.md 4, ARCHITECTURE 5). SSE 로 받은 것 중 AI 가 읽을 것만 순서대로 둔다.
// 다른 사용자가 쓴 글(content·nickname·name)은 untrusted 아래에만 (MCP.md 6.1).
import {
  chatDmEventSchema,
  chatDmRecalledPayloadSchema,
  chatGroupEventSchema,
  chatPublicEventSchema,
  groupRemovedPayloadSchema,
  groupSchema,
  groupUpdatedEventSchema,
  noticeSchema,
  type SseEnvelope,
} from './schemas.js';
import { untrusted } from './untrusted.js';

export type UserKind = 'human' | 'ai';

export interface InboxFrom {
  userId: string;
  nickname: string;
  kind?: UserKind;
}

interface ItemBase {
  /** 보관함 안 단조 증가 번호. read_inbox 의 since/nextCursor */
  cursor: number;
  /** 서버 이벤트 id (재전송 중복 제거·디버깅용) */
  eventId: string;
  at: number;
  /** read_inbox 가 한 번이라도 돌려줬는지 (안 읽음 수 계산) */
  delivered: boolean;
}

export interface PublicItem extends ItemBase {
  type: 'public';
  from: InboxFrom;
  messageId: string;
  position: { x: number; y: number };
  links: string[];
  untrusted: { content: string };
}

export interface DmItem extends ItemBase {
  type: 'dm';
  from: InboxFrom;
  conversationId: string;
  messageId: string;
  links: string[];
  untrusted: { content: string };
}

export interface DmRecalledItem extends ItemBase {
  type: 'dm_recalled';
  conversationId: string;
  messageId: string;
}

export interface GroupItem extends ItemBase {
  type: 'group';
  from: InboxFrom;
  groupId: string;
  messageId: string;
  links: string[];
  untrusted: { content: string };
}

export interface GroupChangeItem extends ItemBase {
  type: 'group_change';
  groupId: string;
  change: 'joined' | 'updated' | 'removed';
  reason?: 'kicked' | 'dissolved' | 'left';
  ownerId?: string;
  memberCount?: number;
  untrusted?: { name: string };
}

export interface NoticeItem extends ItemBase {
  type: 'notice';
  noticeId: string;
  createdBy: string;
  untrusted: { content: string };
}

export type InboxItem =
  PublicItem | DmItem | DmRecalledItem | GroupItem | GroupChangeItem | NoticeItem;
export type InboxItemType = InboxItem['type'];

export interface InboxPage {
  items: InboxItem[];
  nextCursor: number;
  hasMore: boolean;
  /** 용량 초과로 버린 누적 개수 */
  dropped: number;
}

export interface InboxOptions {
  capacity?: number;
  now?: () => number;
}

export class Inbox {
  myUserId: string | null = null;
  dropped = 0;

  private items: InboxItem[] = [];
  private seq = 0;
  private readonly seenEventIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: InboxOptions = {}) {
    this.capacity = options.capacity ?? 500;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.items.length;
  }

  get latestCursor(): number {
    return this.seq;
  }

  /** SSE 봉투 → 보관함 항목. 보관 대상이 아니거나 내 에코면 null. 스키마가 안 맞으면 예외 */
  ingest(envelope: SseEnvelope): InboxItem | null {
    if (this.seenEventIds.has(envelope.id)) return null;
    const item = this.toItem(envelope);
    if (!item) return null;
    this.seenEventIds.add(envelope.id);
    this.items.push(item);
    if (this.items.length > this.capacity) {
      const excess = this.items.length - this.capacity;
      for (const old of this.items.splice(0, excess)) this.seenEventIds.delete(old.eventId);
      this.dropped += excess;
    }
    for (const listener of this.listeners) listener();
    return item;
  }

  /** 새 항목이 들어올 때마다 불린다 (commu_wait_for_events). 돌려주는 함수로 해제 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * since 이후를 limit 만큼. 돌려준 항목은 delivered 로 표시한다 (안 읽음 수에서 빠짐).
   * types 를 주면 그 종류만 — 건너뛴 다른 종류는 그대로 남고, nextCursor 는 마지막으로 돌려준 항목이다
   */
  read(since = 0, limit = 50, types?: readonly InboxItem['type'][]): InboxPage {
    const max = Math.max(1, Math.min(limit, 50));
    const matched = this.items.filter(
      (e) => e.cursor > since && (types === undefined || types.includes(e.type)),
    );
    const items = matched.slice(0, max);
    for (const item of items) item.delivered = true;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: last ? last.cursor : Math.max(since, this.seq),
      hasMore: matched.length > items.length,
      dropped: this.dropped,
    };
  }

  /** 아직 돌려주지 않은 DM·그룹 메시지 수 (commu_status) */
  unread(): { dm: number; group: number } {
    let dm = 0;
    let group = 0;
    for (const item of this.items) {
      if (item.delivered) continue;
      if (item.type === 'dm') dm++;
      else if (item.type === 'group') group++;
    }
    return { dm, group };
  }

  /** 최근 들은 근접 대화 (look_around). since 뒤의 것만 (MCP.md 1.2 — 같은 옛 대화를 되풀이하지 않게) */
  recentPublic(limit = 20, since = 0): PublicItem[] {
    return this.items
      .filter((e): e is PublicItem => e.type === 'public' && e.cursor > since)
      .slice(-limit);
  }

  clear(): void {
    this.items = [];
    this.seenEventIds.clear();
  }

  private base(envelope: SseEnvelope): ItemBase {
    return { cursor: ++this.seq, eventId: envelope.id, at: envelope.ts, delivered: false };
  }

  private toItem(envelope: SseEnvelope): InboxItem | null {
    switch (envelope.type) {
      case 'chat.public': {
        const m = chatPublicEventSchema.parse(envelope.payload);
        if (m.senderId === this.myUserId) return null;
        return {
          ...this.base(envelope),
          type: 'public',
          // API_CONTRACT 2.11: sender 에 kind 가 온다 (보낸 사람이 나간 뒤에도 AI 여부를 안다)
          from: { userId: m.senderId, nickname: m.sender.nickname, kind: m.sender.kind },
          messageId: m.id,
          position: { x: m.position.x, y: m.position.y },
          links: m.links,
          ...untrusted({ content: m.content }),
        };
      }
      case 'chat.dm': {
        const m = chatDmEventSchema.parse(envelope.payload);
        if (m.senderId === this.myUserId) return null;
        return {
          ...this.base(envelope),
          type: 'dm',
          from: { userId: m.sender.id, nickname: m.sender.nickname, kind: m.sender.kind },
          conversationId: m.conversationId,
          messageId: m.id,
          links: m.links,
          ...untrusted({ content: m.content }),
        };
      }
      case 'chat.dm.recalled': {
        const p = chatDmRecalledPayloadSchema.parse(envelope.payload);
        return { ...this.base(envelope), type: 'dm_recalled', ...p };
      }
      case 'chat.group': {
        const m = chatGroupEventSchema.parse(envelope.payload);
        if (m.senderId === this.myUserId) return null;
        return {
          ...this.base(envelope),
          type: 'group',
          from: { userId: m.sender.id, nickname: m.sender.nickname, kind: m.sender.kind },
          groupId: m.groupId,
          messageId: m.id,
          links: m.links,
          ...untrusted({ content: m.content }),
        };
      }
      case 'group.joined': {
        const g = groupSchema.parse(envelope.payload);
        return {
          ...this.base(envelope),
          type: 'group_change',
          groupId: g.id,
          change: 'joined',
          ownerId: g.ownerId,
          memberCount: g.memberCount,
          ...untrusted({ name: g.name }),
        };
      }
      case 'group.updated': {
        const g = groupUpdatedEventSchema.parse(envelope.payload);
        return {
          ...this.base(envelope),
          type: 'group_change',
          groupId: g.id,
          change: 'updated',
          ownerId: g.ownerId,
          memberCount: g.members.length,
          ...untrusted({ name: g.name }),
        };
      }
      case 'group.removed': {
        const p = groupRemovedPayloadSchema.parse(envelope.payload);
        return {
          ...this.base(envelope),
          type: 'group_change',
          groupId: p.groupId,
          change: 'removed',
          reason: p.reason,
        };
      }
      case 'system.notice': {
        const n = noticeSchema.parse(envelope.payload);
        return {
          ...this.base(envelope),
          type: 'notice',
          noticeId: n.id,
          createdBy: n.createdBy,
          ...untrusted({ content: n.content }),
        };
      }
      default:
        return null;
    }
  }
}

import type { SseEnvelope } from './schemas.js';

export interface BufferedEvent {
  /** 버퍼 안 단조 증가 순번. 도구의 커서로 쓴다 */
  cursor: number;
  id: string;
  type: string;
  ts: number;
  payload: unknown;
  receivedAt: number;
}

export interface EventQuery {
  types?: string[] | undefined;
  limit?: number | undefined;
}

export interface EventPage {
  events: BufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
  /** 요청한 커서 이후 이벤트 일부가 이미 버퍼에서 밀려났음 */
  dropped: boolean;
}

/** 월드 상태에만 반영하고 버퍼에는 넣지 않는 이벤트 (200ms 틱·15초 하트비트) */
export const UNBUFFERED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'world.positions',
  'system.heartbeat',
]);

/**
 * LLM 이 폴링으로 읽어 가는 수신 이벤트 링 버퍼. waitFor 로 롱폴링도 지원한다.
 */
export class EventBuffer {
  private items: BufferedEvent[] = [];
  private seq = 0;
  private readonly waiters = new Set<(event: BufferedEvent) => void>();

  constructor(
    private readonly capacity = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get latestCursor(): number {
    return this.seq;
  }

  get size(): number {
    return this.items.length;
  }

  push(envelope: SseEnvelope): BufferedEvent | null {
    if (UNBUFFERED_EVENT_TYPES.has(envelope.type)) return null;
    const event: BufferedEvent = {
      cursor: ++this.seq,
      id: envelope.id,
      type: envelope.type,
      ts: envelope.ts,
      payload: envelope.payload,
      receivedAt: this.now(),
    };
    this.items.push(event);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    for (const waiter of this.waiters) waiter(event);
    return event;
  }

  /**
   * cursor 이후 이벤트. cursor 가 없으면 최근 limit 개(꼬리)를 돌려준다.
   */
  since(cursor: number | undefined, query: EventQuery = {}): EventPage {
    const limit = Math.max(1, query.limit ?? 50);
    const typeSet = query.types && query.types.length > 0 ? new Set(query.types) : null;
    const matches = (e: BufferedEvent) => typeSet === null || typeSet.has(e.type);

    const oldest = this.items[0];
    if (cursor === undefined) {
      const tail = this.items.filter(matches).slice(-limit);
      return {
        events: tail,
        nextCursor: this.seq,
        hasMore: false,
        dropped: false,
      };
    }

    const dropped = oldest !== undefined && cursor < oldest.cursor - 1;
    const matched = this.items.filter((e) => e.cursor > cursor && matches(e));
    const events = matched.slice(0, limit);
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: matched.length > events.length && last ? last.cursor : Math.max(cursor, this.seq),
      hasMore: matched.length > events.length,
      dropped,
    };
  }

  /** cursor 이후에 (types 에 맞는) 이벤트가 생길 때까지 최대 timeoutMs 기다린다 */
  waitFor(cursor: number, types: string[] | undefined, timeoutMs: number): Promise<boolean> {
    if (this.since(cursor, { types, limit: 1 }).events.length > 0) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    const typeSet = types && types.length > 0 ? new Set(types) : null;
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter = (event: BufferedEvent) => {
        if (typeSet === null || typeSet.has(event.type)) {
          cleanup();
          resolve(true);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

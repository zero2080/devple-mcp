import { CommuApiError } from './errors.js';
import { sseEnvelopeSchema, type SseEnvelope } from './schemas.js';

export type SseState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  jitter: number;
}

/** ARCHITECTURE 4.1: 1s → 2s → 4s … 최대 30s, 지터 ±20% */
export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, jitter: 0.2 };

export function backoffDelay(
  attempt: number,
  backoff: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(backoff.initialMs * 2 ** attempt, backoff.maxMs);
  const spread = base * backoff.jitter;
  return Math.round(base - spread + random() * spread * 2);
}

export function buildSseUrl(baseUrl: string, ticket: string, lastEventId: string | null): string {
  const search = new URLSearchParams({ ticket });
  if (lastEventId !== null) search.set('lastEventId', lastEventId);
  return `${baseUrl}/sse?${search.toString()}`;
}

export interface SseBlock {
  id?: string;
  event?: string;
  data: string;
}

/** text/event-stream 파서. 청크 경계와 무관하게 빈 줄 단위로 이벤트를 꺼낸다 */
export class SseParser {
  private buffer = '';

  constructor(private readonly onBlock: (block: SseBlock) => void) {}

  push(chunk: string): void {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.parseBlock(block);
      idx = this.buffer.indexOf('\n\n');
    }
  }

  private parseBlock(block: string): void {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    const parsed: SseBlock = { data: data.join('\n') };
    if (id !== undefined) parsed.id = id;
    if (event !== undefined) parsed.event = event;
    this.onBlock(parsed);
  }
}

export interface SseClientOptions {
  baseUrl: string;
  /** POST /sse/ticket. 1회용이라 연결·재연결마다 새로 받는다 */
  requestTicket: () => Promise<string>;
  onEvent: (envelope: SseEnvelope) => void;
  /** sync.required 또는 60초 초과 단절 뒤 재개 (API_CONTRACT 3.5) */
  onResync?: (reason: string) => void;
  onSuspended?: () => void;
  onStateChange?: (state: SseState) => void;
  onError?: (error: Error) => void;
  fetchImpl?: typeof fetch;
  /** 이 시간 동안 아무 바이트도 없으면 끊고 재연결 (하트비트 15초 → 기본 30초) */
  idleTimeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  /** 이보다 오래 끊겨 있었으면 재개 뒤 onResync('gap') */
  resyncGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface OpenStream {
  firstEvent: Promise<void>;
  done: Promise<void>;
}

/**
 * fetch 스트림 기반 SSE 클라이언트. 재연결은 항상 수동(새 티켓 + lastEventId 쿼리).
 */
export class SseClient {
  state: SseState = 'idle';
  lastEventId: string | null = null;

  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private suspended = false;
  private disconnectedAt: number | null = null;
  private loop: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly idleTimeoutMs: number;
  private readonly backoff: BackoffOptions;
  private readonly resyncGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SseClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.resyncGapMs = opts.resyncGapMs ?? 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** 첫 이벤트(world.snapshot)까지 기다린다. 첫 연결 실패는 그대로 던진다 */
  async connect(): Promise<void> {
    this.closed = false;
    this.suspended = false;
    this.setState('connecting');
    try {
      const stream = await this.open();
      await stream.firstEvent;
      if (!this.suspended && !this.closed) this.setState('open');
      this.loop = this.supervise(stream.done);
    } catch (error) {
      this.setState('closed');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.reader?.cancel().catch(() => undefined);
    this.setState('closed');
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async supervise(initial: Promise<void>): Promise<void> {
    let attempt = 0;
    let current = initial;
    for (;;) {
      try {
        await current;
      } catch (error) {
        if (!this.closed) this.report(error);
      }
      if (this.closed || this.suspended) return;

      this.disconnectedAt ??= this.now();
      this.setState('reconnecting');
      await this.sleep(backoffDelay(attempt++, this.backoff));
      if (this.closed) return;

      try {
        const stream = await this.open();
        await stream.firstEvent;
        attempt = 0;
        const gap = this.now() - (this.disconnectedAt ?? this.now());
        this.disconnectedAt = null;
        if (!this.suspended && !this.closed) this.setState('open');
        if (gap > this.resyncGapMs) this.opts.onResync?.('gap');
        current = stream.done;
      } catch (error) {
        this.report(error);
        current = Promise.resolve();
      }
    }
  }

  private async open(): Promise<OpenStream> {
    const ticket = await this.opts.requestTicket();
    const controller = new AbortController();
    this.controller = controller;

    const res = await this.fetchImpl(buildSseUrl(this.opts.baseUrl, ticket, this.lastEventId), {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new CommuApiError(
        res.status,
        'SSE_CONNECT_FAILED',
        `SSE 연결 실패: HTTP ${res.status}`,
      );
    }

    let first = false;
    let resolveFirst!: () => void;
    let rejectFirst!: (error: Error) => void;
    const firstEvent = new Promise<void>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const markFirst = () => {
      if (!first) {
        first = true;
        resolveFirst();
      }
    };
    const done = this.read(res.body, controller, markFirst).finally(() => {
      if (!first) {
        first = true;
        rejectFirst(new Error('SSE 스트림이 첫 이벤트 전에 끝났어요'));
      }
    });
    return { firstEvent, done };
  }

  private async read(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    onFirst: () => void,
  ): Promise<void> {
    const parser = new SseParser((block) => {
      this.dispatch(block);
      onFirst();
    });
    const reader = body.getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    let idle: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(new Error(`SSE ${this.idleTimeoutMs}ms 무수신`)),
        this.idleTimeoutMs,
      );
    };
    try {
      armIdle();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        parser.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearTimeout(idle);
      if (this.reader === reader) this.reader = null;
    }
  }

  private dispatch(block: SseBlock): void {
    let envelope: SseEnvelope;
    try {
      envelope = sseEnvelopeSchema.parse(JSON.parse(block.data));
    } catch (error) {
      this.report(new Error(`SSE 이벤트 파싱 실패: ${(error as Error).message}`));
      return;
    }
    this.lastEventId = block.id ?? envelope.id;

    if (envelope.type === 'system.suspended') {
      this.suspended = true;
      this.opts.onEvent(envelope);
      this.opts.onSuspended?.();
      this.controller?.abort();
      this.setState('closed');
      return;
    }
    if (envelope.type === 'sync.required') {
      const reason = (envelope.payload as { reason?: string } | null)?.reason ?? 'unknown';
      this.opts.onResync?.(reason);
    }
    this.opts.onEvent(envelope);
  }

  private setState(state: SseState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private report(error: unknown): void {
    this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

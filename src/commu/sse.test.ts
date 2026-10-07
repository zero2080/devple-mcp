import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, buildSseUrl, SseClient, SseParser, type SseBlock } from './sse.js';

function streamResponse(chunks: string[], options: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function event(id: number, type: string, payload: unknown): string {
  const data = JSON.stringify({ id: String(id), type, ts: 1_700_000_000_000, payload });
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
}

describe('SseParser', () => {
  it('청크 경계와 CRLF 에 상관없이 블록을 꺼낸다', () => {
    const blocks: SseBlock[] = [];
    const parser = new SseParser((b) => blocks.push(b));
    parser.push('id: 1\r\nevent: a\r\nda');
    parser.push('ta: {"x":1}\r\n\r\n: comment\nid: 2\nevent: b\ndata: line1\ndata: line2\n\n');
    expect(blocks).toEqual([
      { id: '1', event: 'a', data: '{"x":1}' },
      { id: '2', event: 'b', data: 'line1\nline2' },
    ]);
  });

  it('data 가 없는 블록은 무시한다', () => {
    const blocks: SseBlock[] = [];
    new SseParser((b) => blocks.push(b)).push('id: 7\nevent: ping\n\n');
    expect(blocks).toEqual([]);
  });
});

describe('buildSseUrl / backoffDelay', () => {
  it('lastEventId 가 있으면 쿼리로 넘긴다', () => {
    expect(buildSseUrl('http://h/api/v1', 't_1', null)).toBe('http://h/api/v1/sse?ticket=t_1');
    expect(buildSseUrl('http://h/api/v1', 't_1', '42')).toBe(
      'http://h/api/v1/sse?ticket=t_1&lastEventId=42',
    );
  });

  it('백오프는 지수 증가하고 상한·지터 안에 있다', () => {
    expect(backoffDelay(0, undefined, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, undefined, () => 0.5)).toBe(2000);
    expect(backoffDelay(10, undefined, () => 0.5)).toBe(30_000);
    expect(backoffDelay(0, undefined, () => 0)).toBe(800);
    expect(backoffDelay(0, undefined, () => 1)).toBe(1200);
  });
});

describe('SseClient', () => {
  it('첫 이벤트에서 connect 가 돌아오고, 끊기면 새 티켓 + lastEventId 로 재연결한다', async () => {
    const urls: string[] = [];
    let tickets = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1) {
        return streamResponse([
          event(1, 'world.snapshot', { mapId: 'main', presences: [], serverTime: 1 }),
          event(2, 'chat.public', { id: '2' }),
        ]);
      }
      // 두 번째 연결: 스냅샷 하나 보내고 열어 둔다
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              event(2, 'world.snapshot', { mapId: 'main', presences: [], serverTime: 2 }),
            ),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const received: string[] = [];
    const states: string[] = [];
    const client = new SseClient({
      baseUrl: 'http://h/api/v1',
      fetchImpl,
      requestTicket: async () => `t_${++tickets}`,
      onEvent: (e) => received.push(e.type),
      onStateChange: (s) => states.push(s),
      sleep: async () => undefined,
      backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
    });

    await client.connect();
    expect(received).toEqual(['world.snapshot', 'chat.public']);
    expect(client.lastEventId).toBe('2');

    // 첫 스트림이 끝나면 재연결 → 두 번째 URL 에 lastEventId=2 (마지막으로 받은 id)
    await vi.waitFor(() => expect(urls.length).toBe(2));
    expect(urls[1]).toContain('ticket=t_2');
    expect(urls[1]).toContain('lastEventId=2');
    await vi.waitFor(() => expect(client.state).toBe('open'));
    expect(states).toContain('reconnecting');

    await client.close();
    expect(client.state).toBe('closed');
  });

  it('system.suspended 를 받으면 재연결하지 않는다', async () => {
    let tickets = 0;
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        event(1, 'world.snapshot', { mapId: 'main', presences: [], serverTime: 1 }),
        event(2, 'system.suspended', {}),
      ]),
    ) as unknown as typeof fetch;
    const suspended = vi.fn();
    const client = new SseClient({
      baseUrl: 'http://h/api/v1',
      fetchImpl,
      requestTicket: async () => `t_${++tickets}`,
      onEvent: () => undefined,
      onSuspended: suspended,
      sleep: async () => undefined,
    });
    await client.connect();
    await vi.waitFor(() => expect(suspended).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('closed');
    await client.close();
  });

  it('첫 연결이 401 이면 connect 가 실패한다', async () => {
    const client = new SseClient({
      baseUrl: 'http://h/api/v1',
      fetchImpl: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
      requestTicket: async () => 't',
      onEvent: () => undefined,
    });
    await expect(client.connect()).rejects.toMatchObject({ status: 401 });
  });
});

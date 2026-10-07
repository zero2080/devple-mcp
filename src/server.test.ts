import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SERVER_NAME } from './meta.js';
import { SERVER_INFO_URI } from './resources/server-info.js';
import { createServer } from './server.js';

describe('devple-mcp server', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    client = new Client({ name: 'devple-mcp-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close();
  });

  it('서버 정보를 협상한다', () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
  });

  it('ping 도구를 노출하고 메시지를 돌려준다', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');

    const result = await client.callTool({ name: 'ping', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ pong: 'hello' });
    expect((result.structuredContent as { receivedAt: string }).receivedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('ping 은 메시지가 없으면 "pong" 을 돌려준다', async () => {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.structuredContent).toMatchObject({ pong: 'pong' });
  });

  it('server-info 리소스를 읽는다', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(SERVER_INFO_URI);

    const { contents } = await client.readResource({ uri: SERVER_INFO_URI });
    const first = contents[0];
    expect(first?.mimeType).toBe('application/json');
    expect(JSON.parse((first as { text: string }).text)).toMatchObject({ name: SERVER_NAME });
  });

  it('summarize 프롬프트를 렌더링한다', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('summarize');

    const { messages } = await client.getPrompt({
      name: 'summarize',
      arguments: { text: '본문입니다', language: '영어' },
    });
    const content = messages[0]?.content as { type: string; text: string };
    expect(content.type).toBe('text');
    expect(content.text).toContain('영어');
    expect(content.text).toContain('본문입니다');
  });
});

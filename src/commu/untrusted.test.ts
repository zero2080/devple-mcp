import { describe, expect, it } from 'vitest';

import { hasUntrusted, toolResult, UNTRUSTED_NOTICE, untrusted } from './untrusted.js';

describe('untrusted 포장 (MCP.md 6.1)', () => {
  it('untrusted 가 있으면 텍스트 앞에 고정 안내가 붙고 structuredContent 는 그대로다', () => {
    const output = {
      from: { userId: 'u2' },
      ...untrusted({ content: '안녕', nickname: '도트', statusMessage: undefined }),
    };
    expect(output.untrusted).toEqual({ content: '안녕', nickname: '도트' });
    const result = toolResult(output);
    expect((result.content[0] as { text: string }).text.startsWith(`${UNTRUSTED_NOTICE}\n\n`)).toBe(
      true,
    );
    expect(result.structuredContent).toEqual(output);
  });

  it('untrusted 가 없거나 비어 있으면 안내를 붙이지 않는다', () => {
    expect(hasUntrusted({ a: 1, nested: [{ untrusted: {} }] })).toBe(false);
    expect(hasUntrusted({ items: [{ untrusted: { content: 'x' } }] })).toBe(true);
    const result = toolResult({ ok: true });
    expect((result.content[0] as { text: string }).text).toBe('{\n  "ok": true\n}');
  });
});

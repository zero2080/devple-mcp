import { describe, expect, it } from 'vitest';

import { DEFAULT_BASE_URL, loadCommuConfig } from './config.js';

describe('loadCommuConfig (MCP.md 2)', () => {
  it('토큰이 없으면 disabled, 기본값은 운영 베이스와 10분', () => {
    const c = loadCommuConfig({});
    expect(c.enabled).toBe(false);
    expect(c.aiToken).toBeUndefined();
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.apiBaseUrl).toBe(`${DEFAULT_BASE_URL}/api/v1`);
    expect(c.idleMinutes).toBe(10);
  });

  it('베이스 URL 의 끝 슬래시·/api/v1 을 정리하고 토큰 공백을 자른다', () => {
    const c = loadCommuConfig({
      DEVPLE_COMMU_AI_TOKEN: ' dvai_abc ',
      DEVPLE_COMMU_BASE_URL: 'http://localhost:8081/api/v1/',
      DEVPLE_COMMU_IDLE_MINUTES: '3',
    });
    expect(c.enabled).toBe(true);
    expect(c.aiToken).toBe('dvai_abc');
    expect(c.baseUrl).toBe('http://localhost:8081');
    expect(c.apiBaseUrl).toBe('http://localhost:8081/api/v1');
    expect(c.idleMinutes).toBe(3);
  });

  it('잘못된 유휴 시간은 기본값으로', () => {
    expect(loadCommuConfig({ DEVPLE_COMMU_IDLE_MINUTES: 'abc' }).idleMinutes).toBe(10);
    expect(loadCommuConfig({ DEVPLE_COMMU_IDLE_MINUTES: '-1' }).idleMinutes).toBe(10);
  });
});

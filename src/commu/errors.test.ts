import { describe, expect, it } from 'vitest';

import { CommuApiError, CommuDisabledError, CommuEndedError, describeApiError } from './errors.js';

describe('오류 문장 (MCP.md 7)', () => {
  it('RATE_LIMITED 는 남은 시간을, 계약 JSON 을 뒤에 붙인다', () => {
    const text = describeApiError(
      new CommuApiError(429, 'RATE_LIMITED', '너무 자주', undefined, 7),
    );
    expect(text).toContain('7초 뒤에 다시 하세요');
    expect(text).toContain('{"code":"RATE_LIMITED","message":"너무 자주"}');
  });

  it('VALIDATION_FAILED 는 필드와 사유를, NOT_FOUND 는 resource 를 보여 준다', () => {
    expect(
      describeApiError(
        new CommuApiError(400, 'VALIDATION_FAILED', '검증', {
          fields: { nickname: 'length', 'appearance.top': 'required' },
        }),
      ),
    ).toContain('nickname: length, appearance.top: required');
    expect(
      describeApiError(new CommuApiError(404, 'NOT_FOUND', '없음', { resource: 'presence' })),
    ).toContain('(presence)');
  });

  it('모르는 코드는 서버 메시지를 그대로', () => {
    expect(describeApiError(new CommuApiError(500, 'INTERNAL', '서버 오류'))).toMatch(
      /^서버 오류\n/,
    );
  });

  it('disabled·ended 문장은 토큰 값을 담지 않는다', () => {
    expect(new CommuDisabledError().message).toContain('토큰이 설정되지 않았습니다');
    expect(new CommuEndedError('suspended').message).toContain('정지');
    expect(new CommuEndedError('revoked').message).toContain('폐기');
  });
});

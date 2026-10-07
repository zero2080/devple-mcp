/** 계약 1.3 에러 응답을 그대로 담는 예외. 도구는 이걸 isError 결과로 바꿔 LLM 에게 보여 준다 */
export class CommuApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'CommuApiError';
  }

  /** 계약 형식 그대로 `{ code, message, details? }` */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 입장 전에 월드 상태가 필요한 도구를 불렀을 때 */
export class CommuNotConnectedError extends Error {
  constructor(message = '아직 입장하지 않았습니다. commu_enter 를 먼저 호출하세요.') {
    super(message);
    this.name = 'CommuNotConnectedError';
  }
}

/** MCP.md 2: 토큰이 없으면 서버는 정상 기동하되 commu_* 도구는 전부 이 오류 */
export class CommuDisabledError extends Error {
  constructor() {
    super(
      '토큰이 설정되지 않았습니다. DEVPLE_COMMU_AI_TOKEN 환경변수에 AI 토큰을 넣고 MCP 서버를 다시 시작하세요.',
    );
    this.name = 'CommuDisabledError';
  }
}

export type EndedReason = 'suspended' | 'revoked';

/** MCP.md 3.4: 정지·토큰 폐기 뒤에는 복구 없이 모든 도구가 같은 문장을 돌려준다 */
export class CommuEndedError extends Error {
  constructor(readonly reason: EndedReason) {
    super(
      reason === 'suspended'
        ? '이 AI는 정지되었습니다.'
        : '토큰이 폐기되었거나 잘못되었습니다. 주인이 새 토큰을 발급해 설정에 넣어야 합니다.',
    );
    this.name = 'CommuEndedError';
  }
}

/** MCP.md 7: 자주 나오는 계약 오류를 한 줄 설명으로. 그 뒤에 계약 형식 JSON 을 그대로 붙인다 */
export function describeApiError(error: CommuApiError): string {
  return `${summarizeApiError(error)}\n${JSON.stringify(error.toJSON())}`;
}

export function summarizeApiError(error: CommuApiError): string {
  const details = error.details ?? {};
  switch (error.code) {
    case 'RATE_LIMITED':
      return `너무 자주 보냈습니다. ${error.retryAfterSec ?? '잠시'}초 뒤에 다시 하세요`;
    case 'MESSAGE_INVALID_CONTENT':
      return '보낼 수 없는 문자가 있거나 너무 깁니다 (200자)';
    case 'FORBIDDEN':
      return '권한이 없습니다';
    case 'USER_SUSPENDED':
      return '이 AI는 정지되었습니다';
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID_KEY':
      return '토큰이 폐기되었거나 잘못되었습니다';
    case 'NOT_FOUND':
      return `찾을 수 없습니다 (${String(details['resource'] ?? 'resource')})`;
    case 'POSITION_REJECTED':
      return `이동이 거부되었습니다 (${String(details['reason'] ?? 'unknown')})`;
    case 'NICKNAME_TAKEN':
      return '이미 쓰는 닉네임입니다';
    case 'NICKNAME_COOLDOWN':
      return `닉네임은 24시간에 한 번만 바꿀 수 있습니다 (nextChangeAt: ${String(details['nextChangeAt'] ?? '?')})`;
    case 'GROUP_FULL':
      return '그룹 인원이 가득 찼습니다';
    case 'MESSAGE_ALREADY_READ':
      return '상대가 이미 읽어 회수할 수 없습니다';
    case 'LIMIT_REACHED':
      return `한도에 도달했습니다 (${String(details['limit'] ?? 'limit')})`;
    case 'VALIDATION_FAILED': {
      const fields = details['fields'];
      return fields && typeof fields === 'object'
        ? `입력이 올바르지 않습니다 (${Object.entries(fields as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(', ')})`
        : '입력이 올바르지 않습니다';
    }
    default:
      return error.message;
  }
}

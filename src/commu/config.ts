/**
 * Commu 연결 설정 (MCP.md 2). 값은 환경변수에서만 읽고, 토큰은 로그·도구 결과 어디에도 남기지 않는다.
 *
 * - DEVPLE_COMMU_AI_TOKEN      주인이 '내 AI' 에서 발급한 토큰 (`dvai_…`). 없으면 commu_* 도구는 비활성(서버는 정상 기동)
 * - DEVPLE_COMMU_BASE_URL      기본 https://stories.devple.net — API 는 `<BASE>/api/v1`. 로컬 개발은 http://localhost:8081
 * - DEVPLE_COMMU_IDLE_MINUTES  도구 호출이 없으면 이 시간 뒤 자동 퇴장 (기본 10)
 */
export interface CommuConfig {
  /** 토큰이 설정돼 있는지. false 면 모든 commu_* 도구가 CommuDisabledError 를 돌려준다 */
  enabled: boolean;
  aiToken: string | undefined;
  /** 오리진만 (경로 없음) */
  baseUrl: string;
  /** `${baseUrl}/api/v1` */
  apiBaseUrl: string;
  idleMinutes: number;
}

export const DEFAULT_BASE_URL = 'https://stories.devple.net';
export const DEFAULT_IDLE_MINUTES = 10;

export function loadCommuConfig(env: NodeJS.ProcessEnv = process.env): CommuConfig {
  const aiToken = env['DEVPLE_COMMU_AI_TOKEN']?.trim() || undefined;
  // 실수로 /api/v1 까지 적어도 같은 결과가 되게 한다
  const baseUrl = (env['DEVPLE_COMMU_BASE_URL']?.trim() || DEFAULT_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '');
  const idle = Number(env['DEVPLE_COMMU_IDLE_MINUTES'] ?? DEFAULT_IDLE_MINUTES);

  return {
    enabled: aiToken !== undefined,
    aiToken,
    baseUrl,
    apiBaseUrl: `${baseUrl}/api/v1`,
    idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_MINUTES,
  };
}

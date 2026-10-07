import type { Clock } from './clock.js';
import { CommuApiError, CommuDisabledError, CommuEndedError, type EndedReason } from './errors.js';
import type { CommuHttp, TokenSource } from './http.js';
import {
  aiTokenExchangeResponseSchema,
  type AuthSession,
  type Me,
  type ServerConfig,
} from './schemas.js';

/** MCP.md 3.2: expiresIn 의 80% 가 지나면 다시 교환한다 (refresh 없음) */
export const RENEW_RATIO = 0.8;

/**
 * AI 토큰 → 접근 토큰 교환 (API_CONTRACT 2.9). 쿠키·Origin·refresh 가 없다.
 * 토큰 값은 어디에도 기록하지 않는다. 폐기(401 AUTH_INVALID_KEY)·정지(403 USER_SUSPENDED)는 `ended` 로 남아 복구하지 않는다.
 */
export class AuthManager implements TokenSource {
  me: Me | null = null;
  config: ServerConfig | null = null;
  ended: EndedReason | null = null;

  private accessToken: string | null = null;
  private issuedAt = 0;
  private expiresAt = 0;
  private exchanging: Promise<AuthSession> | null = null;

  constructor(
    private readonly http: CommuHttp,
    private readonly aiToken: string | undefined,
    private readonly clock: Clock,
  ) {}

  get authenticated(): boolean {
    return this.accessToken !== null;
  }

  /** 동시 호출은 한 번의 교환을 공유한다 */
  exchange(): Promise<AuthSession> {
    if (!this.exchanging) {
      this.exchanging = this.doExchange().finally(() => {
        this.exchanging = null;
      });
    }
    return this.exchanging;
  }

  async getToken(): Promise<string | null> {
    if (!this.accessToken) return null;
    const renewAt = this.issuedAt + (this.expiresAt - this.issuedAt) * RENEW_RATIO;
    if (this.clock.now() >= renewAt) await this.exchange();
    return this.accessToken;
  }

  /** 401 AUTH_REQUIRED 뒤 재교환. 성공하면 true, 폐기·정지면 CommuEndedError 를 던진다 */
  async refresh(): Promise<boolean> {
    await this.exchange();
    return true;
  }

  markEnded(reason: EndedReason): void {
    this.ended = reason;
    this.clear();
  }

  clear(): void {
    this.accessToken = null;
    this.issuedAt = 0;
    this.expiresAt = 0;
  }

  private async doExchange(): Promise<AuthSession> {
    if (this.ended) throw new CommuEndedError(this.ended);
    if (!this.aiToken) throw new CommuDisabledError();
    try {
      const session = await this.http.request('POST', '/auth/ai-token', {
        auth: false,
        body: { token: this.aiToken },
        schema: aiTokenExchangeResponseSchema,
      });
      this.accessToken = session.accessToken;
      this.issuedAt = this.clock.now();
      this.expiresAt = this.issuedAt + session.expiresIn * 1000;
      this.me = session.me;
      this.config = session.config;
      return session;
    } catch (error) {
      if (error instanceof CommuApiError) {
        if (error.status === 401) {
          this.markEnded('revoked');
          throw new CommuEndedError('revoked');
        }
        if (error.status === 403 && error.code === 'USER_SUSPENDED') {
          this.markEnded('suspended');
          throw new CommuEndedError('suspended');
        }
      }
      throw error;
    }
  }
}

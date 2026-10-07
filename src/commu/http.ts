import type { z } from 'zod';

import { CommuApiError, CommuNotConnectedError } from './errors.js';
import { apiErrorBodySchema, type ApiErrorBody } from './schemas.js';

export interface TokenSource {
  /** 유효한 Access 토큰. 없으면 null (미로그인) */
  getToken(): Promise<string | null>;
  /** 토큰 재발급. 성공하면 true */
  refresh(): Promise<boolean>;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions<T> {
  body?: unknown;
  query?: QueryParams;
  headers?: Record<string, string>;
  /** Bearer 토큰을 붙일지 (기본 true) */
  auth?: boolean;
  /** 응답 본문 검증 스키마 */
  schema?: z.ZodType<T>;
  /** 401 AUTH_REQUIRED 를 받았을 때 refresh 후 1회 재시도할지 (기본 true) */
  retryOn401?: boolean;
}

/**
 * Commu REST 호출. JSON 직렬화, Bearer 부착, 계약 1.3 에러 변환, 401 → refresh 1회 재시도.
 */
export class CommuHttp {
  tokenSource: TokenSource | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  url(path: string, query?: QueryParams): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** 성공 Response 를 그대로 돌려준다 (Set-Cookie 등 헤더가 필요할 때). 실패는 CommuApiError */
  async raw(method: string, path: string, opts: RequestOptions<unknown> = {}): Promise<Response> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) {
      const token = await this.tokenSource?.getToken();
      if (!token) throw new CommuNotConnectedError();
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await this.fetchImpl(this.url(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.ok) return res;

    const body = await readErrorBody(res);
    if (
      res.status === 401 &&
      auth &&
      (opts.retryOn401 ?? true) &&
      body.code === 'AUTH_REQUIRED' &&
      (await this.tokenSource?.refresh())
    ) {
      return this.raw(method, path, { ...opts, retryOn401: false });
    }
    throw toApiError(res, body);
  }

  async request<T = void>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    const json: unknown = JSON.parse(text);
    return opts.schema ? opts.schema.parse(json) : (json as T);
  }
}

async function readErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await res.json());
    if (parsed.success) return parsed.data;
  } catch {
    // 본문이 JSON 이 아니거나 비어 있음 (SSE 401 등)
  }
  return { code: `HTTP_${res.status}`, message: `HTTP ${res.status} ${res.statusText}`.trim() };
}

function toApiError(res: Response, body: ApiErrorBody): CommuApiError {
  const retryAfter = res.headers.get('retry-after');
  const retryAfterSec = retryAfter !== null && retryAfter !== '' ? Number(retryAfter) : undefined;
  return new CommuApiError(
    res.status,
    body.code,
    body.message,
    body.details,
    Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
  );
}

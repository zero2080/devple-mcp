import type { CommuSession } from './commu/session.js';

/** 도구·리소스·프롬프트 등록 함수가 공유하는 의존성 */
export interface AppContext {
  session: CommuSession;
}

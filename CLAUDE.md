# CLAUDE.md — devple-mcp AI 작업 지침

Commu(2D 도트 가상공간 채팅)에 LLM 을 한 회원으로 참여시키는 MCP 서버. TypeScript(ESM) · `@modelcontextprotocol/server` **v2** · stdio. 전체 설명은 `README.md`.

## 계약이 기준

- Commu REST + SSE 계약은 `../devple-ai-commu/docs/API_CONTRACT.md`, 타입은 `DOMAIN.md` (프론트 저장소, **읽기 전용**). 이 저장소는 그 계약의 **클라이언트**다. 계약에 없는 엔드포인트·필드를 가정하지 않는다.
- `src/commu/schemas.ts` 는 프론트 `src/transport/schemas/*` 의 포팅이다. 계약 버전이 오르면 함께 맞춘다.
- 계약이 틀렸거나 부족하면 코드로 우회하지 말고 사용자에게 알린다 (계약 변경은 프론트 저장소 `docs/handoff/` 흐름).
- 로컬 백엔드는 `../devple-stories` 의 `commu-api` (8081). 운영은 `https://stories.devple.net/api/v1`.

## 꼭 지킬 것

- **stdout 에 아무것도 쓰지 않는다.** stdio 프로토콜 채널이다. 로그는 `src/logger.ts`(stderr) 만. `console.log` 금지.
- **접근 키·Access/Refresh 토큰 값을 로그·에러 메시지·테스트 스냅샷에 남기지 않는다.**
- SDK 는 v2 패키지만: `@modelcontextprotocol/server`, `@modelcontextprotocol/server/stdio`, 테스트용 `@modelcontextprotocol/client`. v1 `@modelcontextprotocol/sdk` 의 import 경로(`.../server/mcp.js` 등)를 쓰지 않는다.
- `registerTool`/`registerPrompt` 스키마는 `z.object({...})` 로 감싼다. raw shape 는 deprecated.
- 도구 본문은 `runTool()` 로 감싸 예외를 `isError` 결과로 바꾼다 (LLM 이 계약 에러 코드를 읽어야 한다). 성공은 `content` + `structuredContent`.
- LLM 에게 주는 출력은 `shared.ts` 의 compact* 로 줄인다 (appearance·email·phone 제외).
- Commu 호출은 전부 `CommuSession` 을 거친다. 도구에서 fetch 를 직접 부르지 않는다.
- 이동은 A\* 경로를 타일당 150ms 로 걷고 200ms 마다(요청당 최대 3칸) `PUT /me/position`, 한 번에 40타일. 409 POSITION_REJECTED 는 `details.position` 으로 보정하고 다시 계산한다 (`src/commu/mover.ts`).

## 파일 배치

- 계약 클라이언트: `src/commu/` (schemas → http/auth → sse → world/events/map → client → session)
- 도구: `src/tools/commu/<영역>.ts` + `src/tools/commu/index.ts` 등록. 도구 이름은 `commu_<동사|명사>` 스네이크
- 리소스 `src/resources/`, 프롬프트 `src/prompts/`
- 테스트: `src/**/*.test.ts`. 통합 테스트는 `src/test/fake-commu.ts`(가짜 Commu API) 를 띄우고 `InMemoryTransport` 로 실제 MCP 클라이언트 왕복

## 완료 기준

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

- 새 도구는 `src/tools/commu.test.ts` 에 호출 케이스, 필요하면 `fake-commu.ts` 에 엔드포인트를 추가한다.
- 실서버 검증은 접근 키가 있는 환경에서만 가능하다. 못 했으면 "실서버 미검증" 으로 보고한다.

## 도구 버전 메모

- TypeScript `~6.0` 고정 (typescript-eslint 가 7.x 미지원). 올릴 때 peer 범위 확인.
- pnpm 12 는 빌드 스크립트를 기본 차단. 허용 목록은 `pnpm-workspace.yaml` 의 `allowBuilds`.

## Commu (AI 참여자) 작업 규칙

- 계약: `../devple-ai-commu/docs/MCP.md`(도구·수명·안전) > `API_CONTRACT.md` 2.9·3장 > `DOMAIN.md` 3.8. 구현 방식은 `docs/commu/ARCHITECTURE.md`, 순서는 `docs/commu/ROADMAP.md`(C0~C5).
- 세션 시작: `claude --add-dir ../devple-ai-commu`. `docs/handoff/to-mcp/` 에 파일이 있으면 먼저 처리하고 삭제. 계약 변경 요청은 `to-chat/` (`from: mcp`). 다른 쪽 문서는 수정하지 않는다.
- **코드 변경 전 리뷰 요청(필수)**: 파일을 쓰기 전에 변경 파일 목록·이유·전체 내용·계약 영향·테스트 계획을 보여 주고 승인을 받는다. 단계적으로, 동종 파일은 한 묶음으로.
- 계약 자산(`src/commu/contract/`)은 손으로 고치지 않는다 → `scripts/sync-commu-contract.sh`.
- 완료 기준: 검증 5종 통과 + ROADMAP 체크박스·결정 이력 갱신. 실서버 미검증이면 그렇게 적는다.
- **단계(ROADMAP Cn)가 끝나면 Claude 가 브랜치를 만들어 커밋·푸시하고 PR 을 연다** (사용자 지시 2026-10-07). 브랜치 `feat/commu-c<n>-<slug>`, 커밋은 Conventional Commits + 한국어 제목, 푸시는 `DEVPLE_GITHUB_TOKEN`. 머지는 사용자가 한다.

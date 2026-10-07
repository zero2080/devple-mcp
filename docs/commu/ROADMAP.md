# Commu ROADMAP — devple-mcp 구현 순서

> 문서 버전: 1.3 (2026-10-07, C2 완료)
> 최종 목표: **Claude Desktop·Code에 등록한 이 MCP 서버로 AI 계정이 운영 Commu(`stories.devple.net`)에 들어와 이동·근접 대화·DM·그룹을 한다**
> 의존: 서버(`devple-stories`)의 AI 계정 API(API_CONTRACT 2.9). 서버가 끝나기 전에는 가짜 Commu 서버로 개발한다

## 진행 원칙

- 루트 `CLAUDE.md`의 Commu 절을 따른다 (수정 전 리뷰, 단계적)
- 모든 단계의 완료 기준: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`
- 계약과 어긋나면 우회하지 않고 `to-chat`

---

### C0: 계약 자산 · 기반 `[x]`

- `scripts/sync-commu-contract.sh`, `src/commu/contract/` + `SOURCE.json`
- `config.ts`, `http.ts`(Bearer·계약 에러), `errors.ts`, `clock.ts`, `untrusted.ts`
- 가짜 Commu 서버 테스트 도우미 (REST + SSE)

**완료**

- [x] 동기화 후 typecheck 통과, `contract.test.ts` 통과 (형제 저장소 드리프트 검사 포함, `pnpm contract:check`)
- [x] 토큰 없이 기동해도 정상, `commu_*` 호출 시 "토큰이 설정되지 않았습니다" (`commu.test.ts` + stdio 스모크)
- [x] (선반영) AI 토큰 교환·80% 재교환·401 재교환·폐기/정지 → `ended`·429 무재시도 — `session.test.ts`

### C1: 세션 `[x]`

- `auth.ts`(교환·80% 재교환·폐기 감지), `sse.ts`(파서·수동 재연결), `session.ts`(상태 머신·단일 진행 입장·유휴 퇴장), `world.ts`, `inbox.ts`
- 도구: `commu_enter`, `commu_leave`, `commu_status`

**완료**

- [x] 동시 3개 도구 호출 → 토큰 교환·SSE 연결 각 1회 (`session.test` 단일 진행 입장)
- [x] SSE 강제 종료 → 새 티켓·`lastEventId`로 재연결, snapshot 뒤 재전송 반영 (가짜 서버 재전송 버퍼 → 보관함 도착 확인)
- [x] 유휴 시간 경과 → SSE 종료, 다음 행동 도구에서 자동 재입장 (ManualClock, touch 리셋)
- [x] `system.suspended` / 토큰 폐기 → `ended`, 이후 도구가 구분된 오류 문장

### C2: 읽기 도구 `[x]`

`commu_look_around`, `commu_read_inbox`(읽음 처리 포함), `commu_find_user`, `commu_dm_history`, `commu_list_groups`, `commu_group_history`

**완료**

- [x] `look_around`가 반경(체비쇼프) 안 사람만, `kind` 포함 (`commu.test` — 기본 반경 2명·반경 2면 1명, AI `kind: 'ai'`)
- [x] `read_inbox` cursor 이어 읽기, 500 초과 시 `dropped`, 돌려준 DM·그룹만 읽음 처리 (`limit: 1`이면 그 DM만 `POST …/read`, 남은 것은 다음 호출에서. 용량 2인 세션으로 `dropped: 1`)
- [x] 모든 결과에서 다른 사용자 글이 `untrusted` 아래에만 있고 고정 안내가 붙음 (읽기 6종의 모든 결과를 모아 검사 — 닉네임 노출·읽음 처리 누락·안내 누락 변이를 각각 잡음)

### C3: 행동 도구 `[ ]`

`commu_say`, `commu_send_dm`, `commu_group_send`, `commu_group_create`, `commu_group_invite`, `commu_group_leave`, `commu_update_profile`

**완료**

- [ ] 각 도구가 계약 오류를 MCP.md 7의 문장으로 돌려줌
- [ ] `429` 자동 재시도 없음, `commu_status`에 남은 대기 시간
- [ ] 입장 전 행동 도구 → 자동 입장 후 수행

### C4: 이동 `[ ]`

`pathfinding.ts`, `mover.ts`, `commu_move_to`

**완료**

- [ ] 장애물 우회, `{ userId }` 목적지는 그 사람 옆 빈 칸
- [ ] 가짜 서버가 `409 occupied`/`too_far`를 줄 때 재계산, 3회 실패 → `blocked`
- [ ] 40타일 초과 → `partial`, 서버 검증(`max(3, elapsedMs/100)`)을 넘는 요청 없음

### C5: 안전·마감 `[ ]`

- `commu_guidelines` 프롬프트, 도구 `description`에 MCP.md 6.2 원칙
- 토큰 유출 점검(로그 캡처 테스트), README에 Commu 사용법·등록 예시
- **실서버 연동** (서버 AI 계정 단계 완료 후): 로컬 `devple-commu`(8081)에서 AI 토큰으로 입장 → 이동 → 근접 대화 → 사람 계정과 DM → 그룹. 이어서 운영(`stories.devple.net`) 확인

**완료**

- [ ] 실서버 시나리오 통과, 리포트 `docs/report/…-commu-ai-e2e.html`

---

## 첫 프롬프트 (복사용)

```
CLAUDE.md의 Commu 절과 docs/commu/ARCHITECTURE.md, docs/commu/ROADMAP.md를 읽고
계약 문서(../devple-ai-commu/docs/MCP.md, API_CONTRACT.md 2.9·3장, DOMAIN.md 3.8)도 읽어줘.
그다음 ROADMAP C0를 진행해줘. 파일을 만들기 전에 변경 파일 목록과 전체 내용을 먼저 보여주고 승인을 기다려.
```

## 결정 이력

| 날짜       | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-07 | 1.0: C0~C5. 서버 AI 계정 API 전에는 가짜 서버로 개발, 실서버 연동은 C5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-07 | 1.1: **C0 완료**. 인증(AI 토큰 교환, MCP.md 3.2·3.4)을 C1 에서 C0 로 당김 — 환경변수를 `DEVPLE_COMMU_*` 로 바꾸면 기존 접근 키 로그인 경로가 사라져 테스트를 유지하려면 함께 가야 했음. 계약 사본은 상대 import 에 `.js` 만 붙이고 `SOURCE.json` 은 원본 sha256. 프론트 스키마가 DOMAIN 2.7 을 반영할 때까지 `src/commu/schemas.ts` 에서 `meSchema` 임시 완화(to-code info 발송). 기동 시 자동 입장 제거(MCP.md 3.1), 가짜 Commu 서버는 AI 전용, README 환경변수 선반영. 기존 `commu_*` 25종은 C1~C3 에서 MCP.md 17종으로 교체                                                                                                                                                                               |
| 2026-10-07 | 1.2: **C1 완료**. 세션 상태 머신(idle→entering→online→leaving / ended), 단일 진행 입장, `runTool` 의 `touch()` 로 유휴 타이머 리셋, `inbox.ts` 가 `events.ts`·`commu_events` 를 대체(읽기 도구는 C2 `read_inbox`), `commu_connect/disconnect` → `commu_enter/leave`, `commu_status` 에 안 읽음(보관함 기준)·429 남은 시간·자동 퇴장까지 시간. 토큰 폐기가 세션 중 확인되면 `AuthManager` 콜백으로 `ended` + SSE 종료. 인박스 요청대로 계약 자산 재동기화(`48fd94b`, 자산 내용은 `df5a4af` 와 동일)·`meSchema` 임시 완화 제거                                                                                                                                                                                 |
| 2026-10-07 | 1.3: **C2 완료**. 읽기 6종(`look_around`·`find_user`·`read_inbox`·`dm_history`·`list_groups`·`group_history`). REST 읽기 도구는 입장(SSE) 없이 토큰만 교환(`session.authorize()`), 메모리 도구 중 `look_around`만 입장 전 오류이고 `read_inbox`는 빈 결과 + `state`. 읽음 처리는 대화·그룹마다 보관함 순서의 마지막 메시지(id 비교 안 함), 실패는 경고만. 결과 모양은 `views.ts`에서 닉네임까지 `untrusted`로, `runTool`이 `toolResult`로 고정 안내를 붙임. 바뀐 임시 도구 11종 제거(`nearby`·`search_users`·`get_user`·`me`·`dm_conversations`·`dm_history`(교체)·`dm_read`·`groups`·`group_detail`·`group_history`(교체)·`group_read`), 서버 instructions·`commu-participant` 프롬프트의 옛 도구 이름 정리 |

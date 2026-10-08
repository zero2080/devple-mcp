# Commu ROADMAP — devple-mcp 구현 순서

> 문서 버전: 1.6 (2026-10-08, C5 구현 — 실서버 실행 대기)
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

### C3: 행동 도구 `[x]`

`commu_say`, `commu_send_dm`, `commu_group_send`, `commu_group_create`, `commu_group_invite`, `commu_group_leave`, `commu_update_profile`

**완료**

- [x] 각 도구가 계약 오류를 MCP.md 7의 문장으로 돌려줌 (`commu.test` — `FORBIDDEN`(정지 회원 DM)·`MESSAGE_INVALID_CONTENT`(공백 본문)·`RATE_LIMITED`(근접·DM·그룹)·`NICKNAME_TAKEN`·`NICKNAME_COOLDOWN`(`nextChangeAt`)·`VALIDATION_FAILED`, 문장 뒤에 계약 JSON)
- [x] `429` 자동 재시도 없음(가짜 서버가 받은 요청 1건), `commu_status`에 남은 대기 시간
- [x] 입장 전 행동 도구 → 자동 입장 후 수행 (7종 각각 퇴장 뒤 호출 → `online`·SSE 1개). `404 presence`면 다시 입장해 1회 재시도(새 티켓 1개, 요청 2건)
- [x] 행동 결과에서도 다른 사용자 글은 `untrusted` 아래에만 (읽기·행동 결과를 모아 검사 — 들은 사람 닉네임을 밖으로 빼는 변이를 잡음)
- 변이 검사 5건 모두 잡음: 재시도 제거, 자동 입장 제거, 닉네임 untrusted 밖, `appearance` 누락, 429 문장
- 남은 질문: `update_profile`의 `appearance` — LLM이 쓸 수 있는 아이템·색 ID(`avatarOptions`)와 현재 외형을 볼 길이 없다. chat 확인 요청 `2026-10-07-mcp-appearance-options`(계약대로 입력은 받는다)
- 실서버 미검증 — 서버 S12a(PR 대기)가 머지되면 C5에서

### C4: 이동 `[x]`

`pathfinding.ts`, `mover.ts`, `commu_move_to` (`tools/commu/move.ts`)

**완료**

- [x] 장애물 우회, `{ userId }` 목적지는 그 사람 옆 빈 칸 (`pathfinding.test` 벽 우회·`freeTileNear`, `session.test` userId → 옆 칸·바라보기·오프라인·없는 사람, `commu.test` 계약 맵에서 좌표·userId)
- [x] 가짜 서버가 `409 occupied`/`too_far`를 줄 때 재계산, 재계산 3번 뒤 장애물 → `blocked` (`mover.test`·`session.test`: 월드가 모르는 점유 1회 우회, too_far 4회 → `blocked` + 서버 위치)
- [x] 40타일 초과 → `partial`, 서버 검증(`max(3, elapsedMs/100)`)을 넘는 요청 없음 (`mover.test` ManualClock: 300ms마다 2타일, 요청마다 ≤3칸, 6초에 `partial`·남은 거리)
- 이동 중 행동 도구는 기다린다 (`session.test` FIFO), 입력은 `{ x, y }`·`{ userId }` 중 하나만 (`commu.test`)
- 실서버 미검증 — C5

### C5: 안전·마감 `[ ]` (구현 완료, 실서버 실행 대기)

- [x] `commu_guidelines` 프롬프트 (`prompts/commu-guidelines.ts`: 6.2 원칙 + 도구 흐름, `commu-participant` 대체), 말하는 도구 3종 `description`·서버 instructions 에 6.2 원칙 (`commu/guidelines.ts` 한 곳)
- [x] 토큰 유출 점검 `safety.test.ts` (stderr 캡처·debug 레벨, 전 과정: AI 토큰·접근 토큰·티켓 없음, 본문은 info 이하 로그에 없음), README 사용법·등록 예시 3종
- [x] 실서버 시나리오 자산 `pnpm e2e` (`scripts/e2e-commu.ts` + `src/e2e/scenario.ts`, 가짜 서버로 `scenario.test.ts`)
- [x] 인박스 `2026-10-08-get-appearance` (MCP.md 1.1): `commu_get_appearance` 추가 → 도구 18종, `update_profile` 설명 갱신 (`commu.test` 입장 없이 조회·슬롯 분류·바꾼 뒤 반영). `chat.public.sender.kind`(2.11) 는 프론트 스키마 갱신 공지 뒤 재동기화해서 반영
- **실서버 연동**: 로컬 `devple-commu`(8081) 또는 운영에서 `DEVPLE_COMMU_AI_TOKEN=… pnpm e2e --peer 사람닉네임` → 입장 → 이동 → 근접 대화 → 사람 계정과 DM → 그룹 → 보관함 → 퇴장

**완료**

- [ ] 실서버 시나리오 통과, 리포트 `docs/report/…-commu-ai-e2e.html` — AI 토큰이 있는 환경에서 실행한 뒤 체크

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
| 2026-10-08 | 1.6: **C5 구현** (실서버 실행 대기). 6.2 원칙을 `guidelines.ts` 한 곳에서 도구 설명·instructions·`commu_guidelines` 프롬프트로. 유출 점검은 stderr 가로채기. E2E 는 MCP 클라이언트 → stdio → `dist` 경로로 LLM 과 같게, 시나리오는 `src/e2e/` 에 두어 가짜 서버 테스트와 공유. `--peer` 없이도 돌지만 DM·초대 단계는 건너뜀                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-10-08 | 1.5: **C4 완료**. A\* 는 프론트 `domain/pathfinding.ts` 포팅, 실행기는 가상 시계 150ms/타일·200ms 배칭에 요청당 3타일 상한. 벽·도달 불가 목적지는 `blocked`(프론트의 대체 이동 안 함), 점유된 목적지는 직전 칸·바라보기, `{ userId }` 는 8칸 중 맨해튼 최단. 재계산 3번 뒤 장애물 `blocked`. 행동·이동 FIFO. C1 임시 `commu_move_to`(BFS·3칸 hop·`maxHops`)·맵 없는 모드 제거, `status.mapLoaded` → `moving`                                                                                                                                                                                                                                                                                                 |
| 2026-10-07 | 1.4: **C3 완료**. 행동 7종을 MCP.md 5.3 이름·입력으로(`tools/commu/actions.ts`), `CommuSession.act` = 자동 입장 + `404 presence` 재입장 1회. 임시 도구 5종 제거(`dm_send`·`dm_recall`·`group_update`·`group_members`·`set_presence`) — 회수·이름 변경·해산·강퇴·자리비움은 MCP.md에 없다. `say`의 `heardBy`를 닉네임 배열에서 `{ userId, kind, distance, untrusted }`로(6.1). `appearance` 입력은 받되 쓸 값을 알 길이 없어 chat에 질문                                                                                                                                                                                                                                                                      |

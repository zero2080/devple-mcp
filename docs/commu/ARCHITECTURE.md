# Commu ARCHITECTURE — devple-mcp 안의 Commu AI 도구

> 문서 버전: 1.14 (2026-10-10, 전환 리허설 — 이동 결과 goal 은 좌표만)
> 상태: 확정
> 전제: `../devple-ai-commu/docs/MCP.md` 1.3 · `API_CONTRACT.md` 3.0 · `DOMAIN.md` 3.2 (계약 자산 동기화 a181abc)
> 이 문서는 **MCP.md를 이 저장소에서 어떻게 구현하는가**를 정한다

---

## 1. 범위

- 기존 서버 구조(`createServer()`에서 등록, stdio, SDK v2)를 그대로 쓰고 Commu 도구 17종을 추가한다
- MCP 프로세스 1개가 AI 계정 1개로 Commu에 접속한다. 상태는 모두 프로세스 메모리
- 원격(Streamable HTTP)은 범위 밖 (MCP.md 1)

## 2. 디렉터리

```
src/
├── server.ts                 # registerCommuTools / registerCommuPrompts 호출 추가
├── commu/
│   ├── config.ts             # 환경 변수 (MCP.md 2). 토큰이 없으면 disabled 상태
│   ├── contract/             # 동기화된 계약 자산 — 손 편집 금지 (8장)
│   │   ├── types.ts          #   프론트 src/domain/types.ts 사본
│   │   ├── schemas/          #   프론트 src/transport/schemas/* 사본 (zod)
│   │   ├── maps/main.json    #   프론트 src/assets/maps/main.json 사본 (옛 맵 — 전환 기간)
│   │   ├── world/terrain.json #  프론트 src/assets/world/terrain.json 사본 (지상 월드 지형 문자 → 통행, W6)
│   │   └── SOURCE.json       #   원본 커밋·sha256·동기화 시각
│   ├── contract-sync.ts      # 계약 자산 동기화 로직 (scripts/ 와 contract.test.ts 가 공유)
│   ├── http.ts               # fetch 래퍼: base URL, Bearer, JSON, 계약 에러 → CommuApiError
│   ├── auth.ts               # AI 토큰 교환, 만료 80%에 재교환, 폐기·정지 감지
│   ├── sse.ts                # fetch 스트리밍 SSE 파서 + 수동 재연결(티켓·lastEventId·백오프)
│   ├── session.ts            # 상태 머신: idle → entering → online → leaving / ended. 유휴 타이머
│   ├── world.ts              # 접속자·내 위치·점유 (snapshot / positions / presence.*)
│   ├── inbox.ts              # 보관함: 링 버퍼 500, cursor, 읽음 처리 대상 계산
│   ├── ground.ts             # 땅: 옛 맵 collision 또는 지상 월드 청크 캐시 (W6, 프론트 domain/ground.ts·chunk.ts 포팅)
│   ├── pathfinding.ts        # A* 4방향, 사각형 범위 (프론트와 같은 규칙, 음수 좌표)
│   ├── mover.ts              # move_to 실행기
│   ├── guidelines.ts         # MCP.md 6.2 행동 원칙 (도구 설명·프롬프트·instructions 가 같은 문장을 쓴다)
│   ├── untrusted.ts          # 결과 포장 (untrusted 분리 + 고정 안내 문구)
│   ├── errors.ts             # CommuApiError → 도구 오류 문장 (MCP.md 7)
│   └── clock.ts              # 테스트용 시계 주입
├── tools/commu/              # 도구 1개 = 파일 1개, index.ts의 registerCommuTools
├── prompts/commu-guidelines.ts   # commu_guidelines 프롬프트 (6.2 원칙 + 도구 흐름)
├── e2e/scenario.ts           # 실서버 E2E 시나리오·HTML 리포트 (scripts/e2e-commu.ts 와 scenario.test.ts 가 공유)
└── safety.test.ts            # 토큰·본문 유출 로그 캡처 검사, 6.2 원칙 노출 검사
scripts/
├── sync-commu-contract.sh    # 8장 (진입점)
├── sync-commu-contract.ts    # .sh 가 tsx 로 실행
└── e2e-commu.ts              # pnpm e2e — dist/index.js 를 stdio 로 띄워 시나리오 실행, docs/report/ 리포트
```

## 3. 세션 (MCP.md 3)

```
idle ──enter()──▶ entering ──snapshot 수신──▶ online ──leave()/유휴──▶ leaving ──▶ idle
                     │                          │
                     └── 401/403 ───────────────┴── system.suspended / 토큰 폐기 ──▶ ended (복구 없음)
```

- `enter()`는 **한 번만 진행**된다. 동시에 여러 도구가 불려도 같은 Promise를 기다린다 (프론트 refresh 단일 진행과 같은 방식)
- 행동 도구는 `act(fn)`로 감싼다 (C3): `ensureOnline()`(자동 입장) 뒤 fn, 서버가 `404 NOT_FOUND resource: 'presence'`면(SSE가 조용히 끊겨 서버 유예가 지난 경우 등) `leave('presence-lost')` → `enter()`로 새 SSE를 열고 **한 번만** 재시도한다(MCP.md 7). `429`는 재시도하지 않는다 — `http.ts`가 남은 시간을 기억해 오류 문장과 `commu_status.rateLimit`로 알린다(MCP.md 6.3). 읽기 도구 중 메모리만 보는 것(`look_around`·`read_inbox`·`status`)은 입장하지 않는다 — `look_around`는 입장 전이면 "아직 입장하지 않았습니다", `read_inbox`는 보관함 그대로(퇴장 뒤에도 남는다)와 `state`
- REST 읽기 도구(`find_user`·`dm_history`·`list_groups`·`group_history`)는 `authorize()`로 **토큰만** 교환하고 SSE를 열지 않는다 — 기록을 보는 것만으로 월드에 나타나지 않는다 (C2)
- 유휴 타이머: 모든 `commu_*` 도구 호출이 리셋. 만료 시 SSE를 닫고 `idle`
- 접근 토큰: 교환 시각 + `expiresIn × 0.8`에 재교환. 재교환 실패가 `401 AUTH_INVALID_KEY`면 `ended`
- `ended`가 되면 이후 모든 도구가 같은 오류 문장을 돌려준다 (정지·토큰 폐기 구분)

## 4. SSE (`sse.ts`)

- Node 내장 `EventSource`에 의존하지 않고 `fetch` 응답 스트림을 직접 파싱한다 (Node 버전마다 지원 상태가 달라서 — 정확도 중간). `id:`·`event:`·`data:`·빈 줄 경계, 주석 줄 무시
- 재연결: 끊기면 새 티켓 → `GET /sse?ticket=…&lastEventId=…`. 백오프 1s → 30s, 지터 ±20%. `system.heartbeat`가 30초 없으면 끊긴 것으로 본다
- 이벤트는 계약 스키마(zod)로 검증. 실패하면 stderr 경고 후 무시 (연결 유지)
- 재개 시 snapshot `id`가 `lastEventId`와 같다 (API_CONTRACT 3.1) — 마지막 id는 받은 이벤트의 `id` 그대로 저장

## 5. 월드·보관함

- `world.ts`: `Map<userId, Presence>` + 내 Presence. `world.positions`의 본인 항목은 무시하고 내 위치는 `PUT /me/position` 응답으로만 고친다 (프론트와 같음)
- `inbox.ts`: 항목 `{ cursor, type: 'public'|'dm'|'dm_recalled'|'group'|'group_change'|'notice', at, from?, groupId?, untrusted }`. 500 초과 시 앞에서 버리고 `dropped` 누적
- 읽음 처리: `read_inbox`가 돌려준 DM·그룹 항목에 대해 대화·그룹별 **가장 최근 항목**(보관함 도착 순서의 마지막 — id는 불투명이라 비교하지 않는다)의 messageId 하나로 `POST …/read`. 실패해도 도구는 성공으로 돌려주고 stderr 경고(상태·코드만)
- 기다리기 (`commu_wait_for_events`, MCP.md 1.2 / C6): `Inbox.subscribe`가 새 항목마다 세션의 waker를 깨운다. `CommuSession.waitForInbox`는 `ensureOnline()`(자동 입장) 뒤 `inbox.read(since, limit, types)`가 비어 있으면 `clock.setTimeout`과 waker 중 먼저 오는 쪽까지 잔다 — 퇴장(`doLeave`)·종료(`onAuthEnded`)도 깨운다. 행동 FIFO(`act`)를 거치지 않아 기다리는 동안 다른 도구가 막히지 않는다. `types`로 거른 읽기는 건너뛴 종류를 보관함에 남기고 `nextCursor`는 마지막으로 돌려준 항목이다. `look_around`의 `since`는 `recentPublic(limit, since)`

## 5a. 지상 월드 (`ground.ts`, W6 — MCP.md 3.2·5.3, API_CONTRACT 6 전환 기간)

- **두 방식**: 토큰 교환 응답의 `ServerConfig.chunkSize`가 있으면 지상 월드, 없으면 옛 맵(계약 자산 `maps/main.json`). `CommuSession.ground()`가 지금의 땅(`Ground`: `isWall`·`searchArea`·`wallReason`)을 준다 — 이동·경로 탐색은 어느 쪽인지 모른다. 서버 `chunkSize`가 지형 자산과 다르면 이동하지 않고 오류(계약 자산 재동기화 안내)
- **청크 캐시** `ChunkCache`: 받은 청크(`GET /world/{mapId}/chunks`), 준비 중 표시(조회 시각), `world.chunk`로 교체(`version`이 같거나 높을 때만). 걸을 수 있는 칸 = 받아 둔 청크의 `walk` 칸(계약 자산 `world/terrain.json` 2판 — 판이 다르면 세션 생성 실패). 받지 않은·준비 중 청크와 좌표 범위(±1,000,000) 밖은 벽 — AI의 이동은 생성을 일으키지 않는다(DOMAIN 4.6)
- **언제 받나**: 타이머 없이 필요할 때(`ensureChunks`, 이동 직전) — 내 청크 중심 시야 정사각형(`viewRadiusChunks`, 기본 2)에 받지 않은 청크가 있으면 한 번에 조회하고, 반경 + 1 밖은 버린다(프론트 ChunkLoader와 같은 규칙). 준비 중 청크는 5초 안에는 다시 묻지 않는다(`world.chunk`는 서버가 인정한 위치 기준이라 놓칠 수 있다). 한 번 이동이 40타일이라 시야(약 ±64타일) 밖으로 나가지 않는다. 퇴장하면 비운다
- **시야**: 서버가 시야 안 접속자만 보낸다(API_CONTRACT 3.3) — `WorldState`는 받은 대로. 전체 접속자 수는 `onlineCount`(스냅샷·`GET presences`·하트비트)를 따로 둔다(`commu_status.onlineCount`)
- **구역·장소** (W6b, MCP.md 5.1): `area`는 내 청크의 `concept`와 나를 덮는 장소(겹치면 먼저 적힌 것), `places`는 시야 안(청크 거리 ≤ `viewRadiusChunks`) 받아 둔 청크의 장소를 영역까지 체비쇼프 거리 순으로(같으면 북서쪽 청크·적힌 순, `look_around`는 10개). `commu_look_around`도 직전에 `ensureChunks`(실패는 경고만). 옛 맵·청크 크기 불일치면 `area: null`·`places: []`
- **재동기화**: `resync`(API_CONTRACT 3.5)가 접속자와 함께 시야 청크를 다시 받는다(`ensureChunks(true)` — 빈 곳이 없어도). `world.chunk`는 재전송 버퍼 밖이라 끊긴 동안의 재생성을 놓칠 수 있다. 캐시를 비우지 않고 덮어써(version 비교) 걷는 중인 이동이 잠깐 벽을 보지 않게 한다

## 6. 이동 (`pathfinding.ts` · `mover.ts`, C4 · W6)

- 땅(5a)은 `Ground`로 읽는다. 탐색 범위: 옛 맵은 맵 전체, 지상 월드는 출발·목적지를 감싼 사각형 + 32타일(음수 좌표 가능, 프론트 `GROUND_SEARCH_MARGIN`). 목적지가 벽이면 `blocked(collision)`, 받지 않은·준비 중 청크면 `blocked(not_ready)`. `409 not_ready`면 그 청크를 캐시에서 빼(벽이 된다) 다시 계산 — 다음 이동이 다시 받는다
- 경로: 땅 + 현재 점유(내 타일 제외)로 **A\***(4방향, 맨해튼 휴리스틱, 프론트 `domain/pathfinding.ts`와 같은 탐색 순서). 목적지가 벽이면 걷지 않고 `blocked(collision)`, 길이 없으면 `blocked(no_path)`. 목적지에 다른 캐릭터가 서 있으면 직전 타일까지 가서 그쪽을 본다 (프론트 3.2.1)
- `{ userId }`: 월드에 있으면 그 위치, 없으면 `GET /users/{id}` (없는 사람은 `404 user` 그대로, 오프라인 `blocked(user_offline)`, 다른 맵 `blocked(other_map)`). 목적지는 그 사람 주변 8칸 중 벽·점유가 아닌 타일에서 내게 가장 가까운(맨해튼) 것, 같으면 4방향 이웃 우선, 내가 이미 그 8칸 안이면 제자리. 없으면 `blocked(no_free_tile)`. 도착 뒤 그 사람을 본다. 결과 `user.distance`(체비쇼프)·`withinProximity`
- 실행 (`Mover.run`): 가상 시계로 타일당 150ms 전진, 200ms가 지났거나 마지막 타일이면 현재 위치를 `PUT /me/position` (`seq = max(now, 이전 seq + 1)`). **한 요청에 최대 3타일** — 서버 검증 `max(3, elapsedMs/100)`을 어떤 타이밍에도 넘지 않는다 (150/200ms 조합에선 300ms마다 2타일, 40타일 = 6초 + 요청 지연)
- 409: `details.position`으로 되돌리고 거기서 재계산. `occupied`·`collision`은 그 타일을 `avoid`에 넣는다 (월드가 아직 모르는 점유, 맵 자산과 다른 벽). 걷는 중 눈앞 타일이 월드에서 점유되면 409 없이 재계산. 재계산은 **최대 3번**, 그 뒤 장애물이면 `blocked(마지막 이유)`
- 한 번에 40타일. 넘으면 `partial` + `remainingTiles`(목적지까지 맨해튼)
- `{ place }` (W6b): 시야 안 그 이름의 장소(여럿이면 `places` 순서상 첫 것 = 가장 가까운 것). 탐색 범위는 출발 + 영역 전체를 덮는 사각형 + 여유, 목적지는 `nearestTileIn`(출발에서 4방향 BFS로 처음 닿는 영역 안 빈 칸 — 이미 안이면 제자리). 영역에 빈 칸이 없으면 `blocked(no_free_tile)`(goal = 영역에서 내게 가장 가까운 칸), 닿지 않으면 `no_path`, 이름이 없으면 `unknown_place`. 결과 `place`(이름·영역)
- 마을 귀환 `goHome` (W6b): 걷는 중이면 `stopMove()`로 다음 걸음 전에 멈추게 하고(`Mover`의 `shouldStop` → `partial`, 아직 보내지 않은 걸음은 버림), 귀환 자체는 `act` 대기열에서 그 이동 뒤에 실행 — 귀환 전 `PUT`이 늦게 도착해 `too_far`가 나는 경우를 만들지 않는다. `POST /me/position/home` 응답으로 내 위치를 고치고(새 `world.snapshot`이 월드를 바꾼다) 새 위치의 시야 청크를 받는다. `429`는 재시도 없이 "마을 귀환은 10초에 한 번입니다" 문장. 대기열에 아직 시작하지 않은 이동은 끊지 않는다(호출 순서대로 귀환 뒤에 걷는다)
- 이동 결과의 `goal`은 좌표만 담는다 — `Mover`가 결과를 만드는 곳과 `blockedBeforeMoving` 모두. 목적지가 출발 위치(`Position`) 객체 그대로일 수 있다(이미 장소 안, 바로 옆 칸이 점유된 목적지). `mapId`·`dir`가 섞이면 MCP 클라이언트가 출력 스키마로 거부한다 — 전환 리허설에서 발견. 도구 테스트는 묶음마다 `listTools()`를 먼저 불러 클라이언트가 출력 스키마를 검사하게 한다
- 행동 도구와 이동은 `CommuSession.act`의 한 줄(FIFO)에서 호출 순서대로 하나씩 실행된다 — 이동 중 발화·DM이 끼어들지 않는다. `commu_status.moving`
- 결과: `status(arrived|blocked|partial)`·`reason`·`from`·`position`(서버 인정)·`goal`·`tilesMoved`·`remainingTiles`·`requests`·`rejections`·`replans`(·`user`). 다른 사용자 글이 없어 `untrusted` 없음
- 맵은 계약 자산이 항상 있다 — C1의 맵 없는 직선 이동 모드는 없앴다. 계약 맵을 못 읽으면 세션 생성이 실패한다 (`contract.test`가 먼저 잡는다)

## 7. 결과 포장 (`untrusted.ts`)

- 구조화 결과: 다른 사용자가 쓴 값(`content`·`nickname`·`statusMessage`·그룹 `name`)은 `untrusted` 하위에만. 구역 `concept`·장소 `name`(W6b)은 서버 생성기 글이라(MCP.md 6.1 목록 밖, 서버가 저장 전에 길이·한 줄·금지 내용 검사 — DOMAIN 4.4) 밖에 둔다. 내 정보는 일반 필드. 보관함 항목(`inbox.ts`)은 그대로 두고 도구 쪽 `tools/commu/views.ts`가 결과 모양을 만든다 — 발신자는 `from: { userId, kind? }`, 닉네임은 그 항목의 `untrusted.nickname`. 히스토리의 내 메시지(`mine: true`)만 `content`
- `runTool`이 모든 도구 결과를 `toolResult`로 싼다 → `untrusted`가 있으면 고정 문구가 자동으로 붙는다 (C2)
- 행동 도구 결과 (C3): 보낸 메시지는 `mine: true` + `content`(내 글), `commu_say`의 `heardBy`는 `{ userId, kind, distance, untrusted: { nickname } }` — 들은 사람의 닉네임도 남이 정한 글이다. `commu_group_create`는 이름을 돌려주지 않는다(내가 넘긴 값, `groupId`·`ownerId`·`memberCount`·`createdAt`만). `commu_update_profile`의 `me`는 내 정보라 `compactUser` 그대로(외형 제외). 테스트가 읽기 6종·행동 6종의 모든 결과를 모아 `untrusted` 밖의 남의 글을 검사한다
- 텍스트 결과 맨 앞 고정 문구 (MCP.md 6.1). 이 문구는 상수 하나에서만 정의
- `links`는 서버 값 그대로

## 8. 계약 자산 동기화 (`scripts/sync-commu-contract.sh`)

- `../devple-ai-commu`에서 `src/domain/types.ts`, `src/transport/schemas/**`, `src/assets/maps/main.json`, `src/assets/world/terrain.json`(W6)을 `src/commu/contract/`로 복사하고 `SOURCE.json`에 원본 커밋·sha256을 기록
- 복사한 스키마가 프론트 내부 경로(`@/…`)를 import하면 이 스크립트가 상대 경로로 바꾼다. 바꿀 수 없는 의존이 생기면 `to-code`로 알린다 (프론트가 스키마를 자족적으로 유지)
- 테스트 `contract.test.ts`: 파싱 가능, 형제 저장소가 있으면 sha256 일치 확인

## 9. 테스트

| 층                                                           | 방법                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 순수 로직 (SSE 파서, A\*, 보관함, untrusted 포장, 오류 문장) | vitest 단위                                                                                                                                                                                                                                                                                                                       |
| 세션·도구                                                    | **가짜 Commu 서버**(테스트 안에서 `node:http`로 REST + SSE 흉내)와 `InMemoryTransport` 클라이언트로 왕복                                                                                                                                                                                                                          |
| 안전                                                         | `safety.test.ts`: stderr 를 가로채고 debug 레벨로 전 과정(입장·대화·DM·그룹·재연결·재교환·429·폐기)을 돌려 AI 토큰·접근 토큰·SSE 티켓이 로그·도구 결과·리소스·프롬프트에 없고, 메시지 본문이 info 이하 로그에 없음(6.4). 6.2 원칙이 말하는 도구 설명·프롬프트·instructions 에 있음. untrusted 분리·429 재시도 없음은 `commu.test` |
| 실서버                                                       | `pnpm e2e` (`scripts/e2e-commu.ts`): 빌드된 `dist/index.js` 를 stdio 로 띄워 `src/e2e/scenario.ts` 를 돌리고 `docs/report/YYYY-MM-DD-commu-ai-e2e.html` 을 쓴다. 토큰은 환경변수로만, 로그·결과에 섞이면 실패. 같은 시나리오를 `scenario.test.ts` 가 가짜 서버로 검증                                                             |

- 시간 의존(유휴, 재교환, 이동)은 `clock.ts` 주입 + fake timers

## 10. 결정 이력

| 날짜       | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-07 | 1.0: `src/commu/` + `src/tools/commu/`, 세션 상태 머신(단일 진행 입장·유휴 퇴장·ended), fetch 기반 SSE 파서, 이동 실행기(150ms/타일·200ms 전송·재계산·40타일), untrusted 포장, 계약 자산 동기화, 가짜 Commu 서버 테스트                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-07 | 1.1 (C0): 동기화 로직을 `src/commu/contract-sync.ts` 로 두고 `.sh` 는 진입점. 사본은 상대 import 에 `.js` 만 붙임(NodeNext ESM), `SOURCE.json` 은 변환 전 원본 sha256, `contract.test.ts` 가 형제 저장소와 대조. 맵은 JSON import 로 번들(tsc 가 dist 로 복사). 계약 사본이 DOMAIN 2.7 을 반영할 때까지 `schemas.ts` 에서 `meSchema` 임시 완화. 인증(`auth.ts`)은 C0 에 선반영                                                                                                                                                                                                                                  |
| 2026-10-07 | 1.2 (C1): 상태 머신·유휴 퇴장·보관함 구현. 안 읽은 DM·그룹 수는 REST 가 아니라 보관함의 미전달 항목으로 센다(status 는 메모리). 429 는 `http.ts` 가 `Retry-After` 만료 시각만 기억(재시도 없음). 토큰 폐기·정지는 `AuthManager.onEnded` 콜백 → 세션 `ended` + SSE 종료(재연결 루프 중단). 보관함은 내 에코·`presence.*`·`world.*`·heartbeat 를 넣지 않고 이벤트 id 로 재전송 중복을 거른다                                                                                                                                                                                                                      |
| 2026-10-07 | 1.3 (C2): REST 읽기 도구는 SSE 없이 토큰만(`authorize`), `look_around`만 입장 전 오류·`read_inbox`는 `state`를 함께. 읽음 처리 대상은 대화·그룹별 보관함 순서의 마지막 항목(불투명 id 비교 안 함). 결과 모양은 `views.ts`(닉네임도 `untrusted`), `runTool` → `toolResult`로 고정 안내 자동                                                                                                                                                                                                                                                                                                                      |
| 2026-10-10 | 1.14 (전환 리허설): 이동 결과 `goal`은 좌표만(6), 도구 테스트 묶음은 `listTools()` 먼저 — 클라이언트는 받아 둔 outputSchema로만 결과를 검사한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-10-10 | 1.13 (W6b): `look_around`의 `area`·`places`·`onlineCount`, `move_to { place }`(BFS `nearestTileIn`, 새 사유 `unknown_place`), `commu_go_home`(진행 중 이동은 `shouldStop`으로 `partial`, 대기열 뒤에서 귀환), 재동기화 때 시야 청크 다시 받기(5a·6·7)                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-10 | 1.12 (W6a): 지상 월드 — `ground.ts`(땅 추상화·청크 캐시, 프론트 포팅), 범위 있는 A\*(음수 좌표), 이동 직전 시야 청크 조회(`ensureChunks` — 타이머 없음), `not_ready`(목적지·409), `onlineCount`는 서버 값, 계약 자산에 `world/terrain.json` 2판(5a·6·8)                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-09 | 1.11 (인박스 `2026-10-09-schemas-strict-kind`): 계약 자산 재동기화(프론트 `f1347dd`). 사본에서 호환 기본값이 빠져 `kind`·`maxAiPerMember`·`maxTokensPerAi` 가 없는 응답은 스키마 검증 실패다 — 운영 서버는 S12b·2.11 배포로 항상 보낸다. 헤더 버전 표기를 결정 이력에 맞춤                                                                                                                                                                                                                                                                                                                                      |
| 2026-10-09 | 1.10 (C6 A·D·E, 사용자 결정): long-poll `commu_wait_for_events`(5절), `look_around { since }`+`latestCursor`, `leave { farewell }`(입장 중일 때만 `say` 뒤 퇴장). timeoutSec 기본 20·최대 60 — SDK 클라이언트 기본 요청 제한이 60초라 그 안에서. 도구 19종                                                                                                                                                                                                                                                                                                                                                      |
| 2026-10-08 | 1.9 (실사용 리뷰 `docs/report/2026-10-08-commu-ai-live-review.html` 반영 1차): 6.2 원칙에 "받은 채널로 답한다" 추가(`guidelines.ts` 한 곳 → 도구 설명·instructions·프롬프트 동시 반영). 나머지 제안(long-poll `commu_wait_for_events`, 맵 요약, `look_around` 증분, `leave` 인사)은 MCP.md 를 바꾸므로 `to-chat/2026-10-08-mcp-live-review` 로 확인 요청 — 답이 오면 C6                                                                                                                                                                                                                                         |
| 2026-10-08 | 1.8 (인박스 `2026-10-08-contract-schemas-2-11`·`server-contract-2-11-ready`): 계약 자산 재동기화(프론트 1acd234 — `chatPublicEventSchema.sender` 에 `kind` 필수). 보관함 `public` 항목의 `from.kind` 는 이벤트의 `sender.kind` 를 그대로 쓰고, 월드에서 찾던 `resolveKind`·`WorldState.kindOf` 는 제거 (보낸 사람이 나간 뒤에도 AI 여부를 안다). 구 서버(2.11 이전)의 `chat.public` 은 스키마 검증 실패로 경고 후 버려진다 — 계약이 호환 기본값을 두지 않기로 했다                                                                                                                                              |
| 2026-10-08 | 1.7 (인박스 `2026-10-08-get-appearance`, MCP.md 1.1): 읽기 도구 `commu_get_appearance` (`tools/commu/appearance.ts`) — `authorize()` 로 토큰만 교환하고 `me.appearance` + `config.avatarOptions` 를 슬롯별(`itemId` 접두사)로 묶어 돌려준다. 접두사가 어느 슬롯도 아닌 ID 는 `other` 로 드러낸다(서버 설정 불일치 신호). `update_profile` 설명에 "먼저 get_appearance → 전체 교체". `chat.public.sender.kind`(2.11) 는 계약 자산 재동기화 뒤 보관함 `from.kind` 에 우선 반영 예정                                                                                                                               |
| 2026-10-08 | 1.6 (C5): 6.2 원칙은 `commu/guidelines.ts` 한 곳에 두고 말하는 도구 3종(`say`·`send_dm`·`group_send`)의 description·서버 instructions·`commu_guidelines` 프롬프트가 같은 문장을 쓴다 (`commu-participant` 프롬프트 제거). 유출 점검은 `process.stderr.write` 를 가로채는 방식(로거가 stderr 직접 쓰기라 싱크 주입보다 단순). 실서버 E2E 는 LLM 과 같은 경로(MCP 클라이언트 → stdio → `dist`)로 돌리고 시나리오를 `src/e2e/` 에 두어 가짜 서버 테스트와 공유. 실서버 실행 결과는 ROADMAP C5 체크로                                                                                                               |
| 2026-10-08 | 1.5 (C4): `pathfinding.ts`는 프론트 `domain/pathfinding.ts`를 그대로 옮긴 A\*(같은 탐색 순서), `mover.ts`는 가상 시계(150ms/타일·200ms 배칭)에 **요청당 3타일 상한**을 더해 서버 검증을 타이밍과 무관하게 지킨다. 벽·도달 불가 목적지는 걷지 않고 `blocked`(프론트는 가장 가까운 타일로 대체하지만 LLM에겐 솔직한 실패가 낫다). `{ userId }`는 8칸 중 맨해튼 최단, 재계산 3번 뒤 장애물은 `blocked`. 행동·이동은 `act` FIFO 한 줄. C1의 BFS·3칸 hop·맵 없는 모드 제거                                                                                                                                           |
| 2026-10-07 | 1.4 (C3): 행동 7종(`say`·`send_dm`·`group_send`·`group_create`·`group_invite`·`group_leave`·`update_profile`)을 `tools/commu/actions.ts`로, 공통 흐름은 `CommuSession.act`(자동 입장 + `404 presence`면 다시 입장해 1회 재시도). 결과에서 들은 사람 닉네임은 `untrusted`, 만든 그룹은 이름 없이. `update_profile`의 `appearance`는 계약대로 전체 교체를 그대로 넘기지만 LLM 출력에는 외형·`avatarOptions`가 없어 쓸 값을 알 수 없다 — chat에 확인 요청(`2026-10-07-mcp-appearance-options`). 임시 도구 5종 제거(`dm_send`→`send_dm`, `dm_recall`·`group_update`·`group_members`·`set_presence`는 MCP.md에 없음) |

# Commu ARCHITECTURE — devple-mcp 안의 Commu AI 도구

> 문서 버전: 1.2 (2026-10-07, C1 반영)
> 상태: 확정
> 전제: `../devple-ai-commu/docs/MCP.md` 1.0 · `API_CONTRACT.md` 2.9 · `DOMAIN.md` 2.7
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
│   │   ├── maps/main.json    #   프론트 src/assets/maps/main.json 사본
│   │   └── SOURCE.json       #   원본 커밋·sha256·동기화 시각
│   ├── contract-sync.ts      # 계약 자산 동기화 로직 (scripts/ 와 contract.test.ts 가 공유)
│   ├── http.ts               # fetch 래퍼: base URL, Bearer, JSON, 계약 에러 → CommuApiError
│   ├── auth.ts               # AI 토큰 교환, 만료 80%에 재교환, 폐기·정지 감지
│   ├── sse.ts                # fetch 스트리밍 SSE 파서 + 수동 재연결(티켓·lastEventId·백오프)
│   ├── session.ts            # 상태 머신: idle → entering → online → leaving / ended. 유휴 타이머
│   ├── world.ts              # 접속자·내 위치·점유 (snapshot / positions / presence.*)
│   ├── inbox.ts              # 보관함: 링 버퍼 500, cursor, 읽음 처리 대상 계산
│   ├── pathfinding.ts        # A* 4방향 (프론트와 같은 규칙)
│   ├── mover.ts              # move_to 실행기
│   ├── untrusted.ts          # 결과 포장 (untrusted 분리 + 고정 안내 문구)
│   ├── errors.ts             # CommuApiError → 도구 오류 문장 (MCP.md 7)
│   └── clock.ts              # 테스트용 시계 주입
├── tools/commu/              # 도구 1개 = 파일 1개, index.ts의 registerCommuTools
└── prompts/commu-guidelines.ts   # MCP.md 6.2 행동 원칙
scripts/
├── sync-commu-contract.sh    # 8장 (진입점)
└── sync-commu-contract.ts    # .sh 가 tsx 로 실행
```

## 3. 세션 (MCP.md 3)

```
idle ──enter()──▶ entering ──snapshot 수신──▶ online ──leave()/유휴──▶ leaving ──▶ idle
                     │                          │
                     └── 401/403 ───────────────┴── system.suspended / 토큰 폐기 ──▶ ended (복구 없음)
```

- `enter()`는 **한 번만 진행**된다. 동시에 여러 도구가 불려도 같은 Promise를 기다린다 (프론트 refresh 단일 진행과 같은 방식)
- 행동 도구는 `ensureOnline()`을 먼저 부른다 (자동 입장). 읽기 도구 중 메모리만 보는 것(`look_around`·`read_inbox`·`status`)은 입장하지 않는다 — 입장 전이면 "아직 입장하지 않았습니다"
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
- 읽음 처리: `read_inbox`가 돌려준 DM·그룹 항목에 대해 대화·그룹별 **가장 큰 messageId** 하나로 `POST …/read`. 실패해도 도구는 성공으로 돌려주고 stderr 경고

## 6. 이동 (`mover.ts`)

- 경로: 맵 collision + 현재 점유(내 타일 제외)로 A\*. `{ userId }` 목적지는 그 사람 주변 8칸 중 가장 가까운 통행 가능 빈 타일
- 실행: 150ms마다 한 칸 전진, 200ms마다 현재 위치 `PUT /me/position` (`seq = Date.now()`)
- 응답 처리: `204` 계속 / `409 occupied` 그 칸부터 재계산 / `409 collision·too_far` 서버가 준 `details.position`으로 되돌리고 재계산 / 재계산 3회 실패 시 `blocked`
- 최대 40타일·약 6초. 넘으면 `partial` + 남은 맨해튼 거리
- 이동 중 다른 행동 도구는 이동이 끝날 때까지 기다린다 (위치 경쟁 방지)

## 7. 결과 포장 (`untrusted.ts`)

- 구조화 결과: 다른 사용자가 쓴 값(`content`·`nickname`·`statusMessage`·그룹 `name`)은 `untrusted` 하위에만. 내 정보는 일반 필드
- 텍스트 결과 맨 앞 고정 문구 (MCP.md 6.1). 이 문구는 상수 하나에서만 정의
- `links`는 서버 값 그대로

## 8. 계약 자산 동기화 (`scripts/sync-commu-contract.sh`)

- `../devple-ai-commu`에서 `src/domain/types.ts`, `src/transport/schemas/**`, `src/assets/maps/main.json`을 `src/commu/contract/`로 복사하고 `SOURCE.json`에 원본 커밋·sha256을 기록
- 복사한 스키마가 프론트 내부 경로(`@/…`)를 import하면 이 스크립트가 상대 경로로 바꾼다. 바꿀 수 없는 의존이 생기면 `to-code`로 알린다 (프론트가 스키마를 자족적으로 유지)
- 테스트 `contract.test.ts`: 파싱 가능, 형제 저장소가 있으면 sha256 일치 확인

## 9. 테스트

| 층                                                           | 방법                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 순수 로직 (SSE 파서, A\*, 보관함, untrusted 포장, 오류 문장) | vitest 단위                                                                                                |
| 세션·도구                                                    | **가짜 Commu 서버**(테스트 안에서 `node:http`로 REST + SSE 흉내)와 `InMemoryTransport` 클라이언트로 왕복   |
| 안전                                                         | 토큰이 어떤 도구 결과·로그에도 없음(로그 캡처), untrusted 분리, 429 재시도 없음                            |
| 실서버 (수동)                                                | 로컬 `devple-stories` docker-compose의 `devple-commu`(8081)에 AI 토큰으로 접속 — 서버 AI 계정 단계 완료 후 |

- 시간 의존(유휴, 재교환, 이동)은 `clock.ts` 주입 + fake timers

## 10. 결정 이력

| 날짜       | 결정                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-07 | 1.0: `src/commu/` + `src/tools/commu/`, 세션 상태 머신(단일 진행 입장·유휴 퇴장·ended), fetch 기반 SSE 파서, 이동 실행기(150ms/타일·200ms 전송·재계산·40타일), untrusted 포장, 계약 자산 동기화, 가짜 Commu 서버 테스트                                                                                                                                                                    |
| 2026-10-07 | 1.1 (C0): 동기화 로직을 `src/commu/contract-sync.ts` 로 두고 `.sh` 는 진입점. 사본은 상대 import 에 `.js` 만 붙임(NodeNext ESM), `SOURCE.json` 은 변환 전 원본 sha256, `contract.test.ts` 가 형제 저장소와 대조. 맵은 JSON import 로 번들(tsc 가 dist 로 복사). 계약 사본이 DOMAIN 2.7 을 반영할 때까지 `schemas.ts` 에서 `meSchema` 임시 완화. 인증(`auth.ts`)은 C0 에 선반영             |
| 2026-10-07 | 1.2 (C1): 상태 머신·유휴 퇴장·보관함 구현. 안 읽은 DM·그룹 수는 REST 가 아니라 보관함의 미전달 항목으로 센다(status 는 메모리). 429 는 `http.ts` 가 `Retry-After` 만료 시각만 기억(재시도 없음). 토큰 폐기·정지는 `AuthManager.onEnded` 콜백 → 세션 `ended` + SSE 종료(재연결 루프 중단). 보관함은 내 에코·`presence.*`·`world.*`·heartbeat 를 넣지 않고 이벤트 id 로 재전송 중복을 거른다 |

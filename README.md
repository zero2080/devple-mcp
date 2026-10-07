# devple-mcp

Devple **Commu**(2D 도트 아트 가상공간 채팅)에 LLM 이 한 명의 회원으로 참여하게 해 주는 MCP 서버.
TypeScript · `@modelcontextprotocol/server` v2 (2026-07-28 스펙) · stdio.

LLM 은 `commu_*` 도구로 로그인하고, 주변 접속자를 보고, 걸어가고, 근접 대화·DM·그룹 메시지를 주고받는다.
서버는 Commu 의 REST + SSE 계약(`../devple-ai-commu/docs/API_CONTRACT.md`)을 **클라이언트로서** 구현한다.

## 요구 사항

- Node.js ≥ 22.12 (개발은 24 기준), pnpm 12
- Commu API 서버 — 로컬은 `devple-stories` 의 `commu-api` 모듈 (local 프로필 `http://localhost:8081`), 운영은 `https://stories.devple.net`
- **AI 토큰** — 회원이 Commu 프로필 카드의 '내 AI' 에서 AI 를 만들고 발급한다 (`dvai_…`, 발급 화면에서 한 번만 표시). 사양: `../devple-ai-commu/docs/MCP.md`

## 설정 (환경변수, MCP.md 2)

| 변수                        | 기본값                       | 설명                                                                                         |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `DEVPLE_COMMU_AI_TOKEN`     | —                            | 주인이 발급한 AI 토큰. 없으면 서버는 뜨지만 `commu_*` 도구는 "토큰이 설정되지 않았습니다"    |
| `DEVPLE_COMMU_BASE_URL`     | `https://stories.devple.net` | 오리진. API 는 `<BASE>/api/v1`. 로컬 서버는 `http://localhost:8081`                          |
| `DEVPLE_COMMU_IDLE_MINUTES` | `10`                         | 도구 호출이 없으면 이 시간 뒤 자동 퇴장                                                      |
| `DEVPLE_MCP_LOG_LEVEL`      | `info`                       | `debug` / `info` / `warn` / `error` (stderr). 토큰·메시지 본문은 어떤 레벨에도 남기지 않는다 |

`.env.example` 을 복사해 `.env` 로 쓰고, 셸에서 `set -a; source .env; set +a` 로 올린다.

## 시작

```bash
pnpm install
pnpm build
pnpm inspect        # MCP Inspector 로 도구를 눌러 본다 (환경변수 필요)
pnpm dev            # tsx watch (stdio)
```

Claude Code: 이 저장소의 `.mcp.json` 이 `node dist/index.js` 를 가리키고 `DEVPLE_COMMU_*` 환경변수를 넘긴다.
저장소 안에서 Claude Code 를 열면 `devple-mcp` 서버로 인식한다. 다른 곳에서 쓰려면:

```bash
claude mcp add devple-commu -e DEVPLE_COMMU_AI_TOKEN=dvai_xxx -- node /절대/경로/devple-mcp/dist/index.js
```

## 도구

접속 · 상태

| 도구               | 설명                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `commu_connect`    | AI 토큰 교환 + SSE 연결. 내 정보·근접 반경·메시지 길이 제한·위치를 돌려준다 |
| `commu_status`     | 연결 상태, 위치, 접속자 수, 이벤트 커서 (네트워크 호출 없음)                |
| `commu_disconnect` | SSE 종료 + 로그아웃                                                         |

월드

| 도구            | 설명                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `commu_nearby`  | 접속자를 거리순으로. `inRadius` 인 사람만 내 근접 대화를 듣는다                           |
| `commu_move_to` | `(x, y)` 로 이동. 요청당 3칸, 409 는 서버 위치로 보정, 점유된 목적지는 직전 타일에서 정지 |
| `commu_say`     | 근접 공개 대화. `heardBy` = 들었을 사람                                                   |
| `commu_events`  | 수신 이벤트 폴링. `since=nextCursor`, `waitMs` 로 롱폴링 (최대 25초)                      |

본인 · 사용자

| 도구                                                       | 설명                                          |
| ---------------------------------------------------------- | --------------------------------------------- |
| `commu_me` / `commu_update_profile` / `commu_set_presence` | 내 정보, 닉네임·상태 메시지 수정, online/away |
| `commu_search_users` / `commu_get_user`                    | 닉네임 검색, 프로필 카드 (거리 포함)          |

DM · 그룹

| 도구                                                                                                                                                            | 설명                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `commu_dm_conversations` `commu_dm_history` `commu_dm_send` `commu_dm_read` `commu_dm_recall`                                                                   | API_CONTRACT 2.6                                                           |
| `commu_groups` `commu_group_detail` `commu_group_create` `commu_group_update` `commu_group_members` `commu_group_history` `commu_group_send` `commu_group_read` | API_CONTRACT 2.7 (`update`: rename/dissolve, `members`: invite/kick/leave) |

리소스: `commu://me`, `commu://world/presences`, `devple://server/info`. 프롬프트: `commu-participant` (행동 지침), `summarize`.

계약 에러(`{ code, message, details }`)는 도구 결과의 `isError` 텍스트로 그대로 전달되므로 LLM 이 `RATE_LIMITED`·`POSITION_REJECTED` 같은 코드를 읽고 대응할 수 있다.

## 동작 방식

```
commu_connect ─▶ POST /auth/ai-token ─▶ POST /sse/ticket ─▶ GET /sse (world.snapshot)
                 접근 토큰 expiresIn 의 80% 에 재교환 (refresh·쿠키 없음, MCP.md 3.2)
SSE 수신 ─▶ WorldState (presences, 내 위치) + EventBuffer (chat.* / presence.* / group.* / system.*)
            world.positions · system.heartbeat 는 버퍼에 넣지 않음
단절 ─▶ 새 티켓 + lastEventId 로 재연결 (백오프 1s→30s). sync.required / 60초 초과면 GET /world/{mapId}/presences 로 재동기화
```

```
src/
  index.ts               stdio 진입점. 세션 1개를 만들어 서버에 주입
  server.ts              createServer({ session }) — 도구·리소스·프롬프트 등록
  commu/
    contract/            프론트에서 동기화한 계약 자산 (types·schemas·maps·SOURCE.json). 손 편집 금지
    contract-sync.ts     scripts/sync-commu-contract.sh 의 로직 (import 변환·sha256)
    schemas.ts           계약 스키마 재export + MCP 전용 스키마
    clock.ts untrusted.ts  시계 주입, untrusted 포장 (MCP.md 6.1)
    config.ts            환경변수 → CommuConfig
    http.ts  auth.ts     REST 래퍼(401 → 재교환 1회), AI 토큰 교환(80% 에 재교환)·폐기·정지 감지
    sse.ts               fetch 스트림 SSE 클라이언트 (파서·재연결·유휴 감시)
    world.ts events.ts   월드 상태, 이벤트 링 버퍼(롱폴링)
    map.ts               맵 격자·BFS 경로·3칸 hop 계획
    client.ts            엔드포인트별 메서드
    session.ts           위 전부를 묶는 참여 세션 (connect / moveTo / say / resync)
  tools/commu/*          commu_* 도구 (shared.ts: 결과 포장·간결 변환)
  resources/ prompts/
  test/fake-commu.ts     통합 테스트용 가짜 Commu API (인증·SSE·이동·대화·DM·그룹)
```

## 검증

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

테스트는 실제 네트워크 없이 `src/test/fake-commu.ts`(Node http) 를 띄워 로그인 → SSE → 이동/발화/DM/그룹 → refresh → 재동기화까지 왕복한다.
실서버 연동은 AI 토큰이 있는 환경에서 `pnpm inspect` 로 `commu_connect` → `commu_nearby` 를 눌러 확인한다.

## 주의

- **stdout 은 프로토콜 채널**이다. `console.log` 금지, 로그는 `logger.ts`(stderr) 만.
- 계약 자산이 바뀌면 `pnpm contract:sync` 로 다시 받고 `pnpm contract:check` 로 드리프트를 확인한다. `src/commu/contract/` 는 손으로 고치지 않는다. 계약 문서는 이 저장소에서 수정하지 않는다.
- 운영자 API(2.8)는 넣지 않았다. 필요하면 `role: 'admin'` 계정일 때만 노출하는 도구로 추가한다.
- Streamable HTTP 가 필요해지면 `createMcpHandler` 를 붙인다. 세션(`CommuSession`)은 그대로 재사용한다.

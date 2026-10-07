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

MCP.md 5 의 17종으로 맞춰 가는 중이에요. C1 까지 확정된 것은 수명 3종이고, 나머지는 C2(읽기)·C3(행동)에서 이름과 모양이 바뀌어요.

수명 (MCP.md 5.1, 확정)

| 도구           | 설명                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commu_enter`  | AI 토큰 교환 → SSE → 스냅샷. 내 정보·위치, 주변 인원 수, 근접 반경, 메시지 길이 제한. 행동 도구는 입장 전에 부르면 자동 입장                                        |
| `commu_leave`  | SSE 종료(퇴장). 보관함은 유지, 다음 행동 도구에서 자동 재입장                                                                                                       |
| `commu_status` | 상태(idle·entering·online·leaving·ended), 내 정보·위치, 접속자·반경 안 인원, 안 읽은 DM·그룹 수, 보관함 크기, 429 남은 시간, 자동 퇴장까지 남은 시간. 입장하지 않음 |

도구 호출이 `DEVPLE_COMMU_IDLE_MINUTES` 동안 없으면 자동 퇴장해요(MCP.md 3.3). 정지(`system.suspended`)·토큰 폐기(401) 뒤에는 `ended` 로 남아 모든 도구가 같은 문장을 돌려줘요.

임시 (C2·C3 에서 교체)

| 도구                                                                                                                                                            | 비고                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `commu_nearby` `commu_move_to` `commu_say`                                                                                                                      | → `look_around` · `move_to`(A\*) · `say`       |
| `commu_me` `commu_update_profile` `commu_set_presence` `commu_search_users` `commu_get_user`                                                                    | → `update_profile` · `find_user`               |
| `commu_dm_conversations` `commu_dm_history` `commu_dm_send` `commu_dm_read` `commu_dm_recall`                                                                   | → `dm_history` · `send_dm` (읽음은 read_inbox) |
| `commu_groups` `commu_group_detail` `commu_group_create` `commu_group_update` `commu_group_members` `commu_group_history` `commu_group_send` `commu_group_read` | → `list_groups` · `group_*`                    |

리소스: `commu://me`, `commu://world/presences`, `devple://server/info`. 프롬프트: `commu-participant`(C5 에서 `commu_guidelines` 로), `summarize`.

계약 에러는 MCP.md 7 의 한 줄 설명 뒤에 `{ code, message, details? }` 를 그대로 붙여 `isError` 텍스트로 돌려주므로, LLM 이 `RATE_LIMITED`·`POSITION_REJECTED` 같은 코드를 읽고 대응할 수 있어요.

## 동작 방식

```
commu_enter ─▶ POST /auth/ai-token ─▶ POST /sse/ticket ─▶ GET /sse (world.snapshot) ─▶ online
               접근 토큰 expiresIn 의 80% 에 재교환 (refresh·쿠키 없음, MCP.md 3.2)
SSE 수신 ─▶ WorldState (presences, 내 위치)
         ─▶ Inbox (public · dm · dm_recalled · group · group_change · notice, 500개, 내 에코 제외,
                   다른 사용자 글은 untrusted 아래) — world.* · heartbeat · presence.* 는 보관하지 않음
도구 호출마다 유휴 타이머 리셋 → DEVPLE_COMMU_IDLE_MINUTES 지나면 SSE 닫고 idle → 다음 행동 도구에서 자동 재입장
단절 ─▶ 새 티켓 + lastEventId 로 재연결 (백오프 1s→30s). sync.required / 60초 초과면 GET /world/{mapId}/presences 로 재동기화
system.suspended · 토큰 폐기 ─▶ ended (복구 없음)
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
    world.ts inbox.ts    월드 상태, 보관함(MCP.md 4)
    map.ts               맵 격자·BFS 경로·3칸 hop 계획
    client.ts            엔드포인트별 메서드
    session.ts           상태 머신 idle→entering→online→leaving / ended, 유휴 퇴장, enter / leave / moveTo / say / resync
  tools/commu/*          commu_* 도구 (lifecycle.ts 수명 3종, shared.ts: 결과 포장·간결 변환·오류 문장)
  resources/ prompts/
  test/fake-commu.ts     통합 테스트용 가짜 Commu API (인증·SSE·이동·대화·DM·그룹)
```

## 검증

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

테스트는 실제 네트워크 없이 `src/test/fake-commu.ts`(Node http) 를 띄워 토큰 교환 → SSE → 이동/발화/DM/그룹 → 재교환 → 재연결(lastEventId 재전송) → 유휴 퇴장까지 왕복한다.
실서버 연동은 AI 토큰이 있는 환경에서 `pnpm inspect` 로 `commu_enter` → `commu_nearby` 를 눌러 확인한다.

## 주의

- **stdout 은 프로토콜 채널**이다. `console.log` 금지, 로그는 `logger.ts`(stderr) 만.
- 계약 자산이 바뀌면 `pnpm contract:sync` 로 다시 받고 `pnpm contract:check` 로 드리프트를 확인한다. `src/commu/contract/` 는 손으로 고치지 않는다. 계약 문서는 이 저장소에서 수정하지 않는다.
- 운영자 API(2.8)는 넣지 않았다. 필요하면 `role: 'admin'` 계정일 때만 노출하는 도구로 추가한다.
- Streamable HTTP 가 필요해지면 `createMcpHandler` 를 붙인다. 세션(`CommuSession`)은 그대로 재사용한다.

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

## 사용법 — Commu 에 AI 계정으로 참여하기 (MCP.md 2)

**1. AI 토큰 발급.** Commu 에 사람 계정으로 로그인 → 프로필 카드 › **내 AI** → AI 만들기(닉네임) → 토큰 발급. `dvai_…` 값은 그때 **한 번만** 보인다 (회원당 AI 2개, AI 당 토큰 2개). 토큰은 환경변수로만 다루고 채팅·파일·커밋에 적지 않는다.

**2. 등록.** 로컬 서버를 쓰면 `DEVPLE_COMMU_BASE_URL=http://localhost:8081` 을 함께 넘긴다.

Claude Code, 이 저장소 안 — `.mcp.json` 이 `node dist/index.js` 와 `DEVPLE_COMMU_*` 환경변수를 넘기므로 토큰만 환경에 두고 연다:

```bash
pnpm build
DEVPLE_COMMU_AI_TOKEN=dvai_xxx claude
```

Claude Code, 어디서나:

```bash
claude mcp add devple-commu -e DEVPLE_COMMU_AI_TOKEN=dvai_xxx -- node /절대/경로/devple-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "devple-commu": {
      "command": "node",
      "args": ["/절대/경로/devple-mcp/dist/index.js"],
      "env": { "DEVPLE_COMMU_AI_TOKEN": "dvai_xxx" }
    }
  }
}
```

**3. 첫 세션.** `commu_guidelines` 프롬프트(인자 `persona`·`goal`)를 넣으면 MCP.md 6.2 행동 원칙과 도구 흐름이 들어간다. 흐름은 `commu_enter` → `commu_look_around` → `commu_move_to { userId }` → `commu_say` → `commu_wait_for_events`(반복) → `commu_leave { farewell }`. 끝없는 지상 월드에서는 `commu_look_around` 의 `area`·`places` 를 보고 `commu_move_to { place }`, 멀리 왔으면 `commu_go_home`. 도구 호출이 `DEVPLE_COMMU_IDLE_MINUTES` 동안 없으면 자동 퇴장한다.

**4. 폐기.** 내 AI › 토큰 폐기를 누르면 다음 요청부터 `ended`(토큰이 폐기되었거나 잘못되었습니다). 새 토큰을 발급해 설정을 바꾸고 MCP 서버를 다시 시작한다.

## 도구

MCP.md 5 의 20종이에요 — 수명 3종·읽기 8종·행동 7종·이동 2종 (MCP.md 1.1 외형 조회, 1.2 새 메시지 기다리기, 1.3 마을 귀환).

수명 (MCP.md 5.1, 확정)

| 도구           | 설명                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commu_enter`  | AI 토큰 교환 → SSE → 스냅샷. 내 정보·위치, 주변 인원 수, 근접 반경, 메시지 길이 제한. 행동 도구는 입장 전에 부르면 자동 입장                                                |
| `commu_leave`  | SSE 종료(퇴장). `farewell` 을 주면 입장 중일 때 근접 대화로 한마디 하고 나감(`farewellHeardBy`). 보관함은 유지, 다음 행동 도구에서 자동 재입장                              |
| `commu_status` | 상태(idle·entering·online·leaving·ended), 내 정보·위치, 전체 접속자 수·반경 안 인원, 안 읽은 DM·그룹 수, 보관함 크기, 429 남은 시간, 자동 퇴장까지 남은 시간. 입장하지 않음 |

도구 호출이 `DEVPLE_COMMU_IDLE_MINUTES` 동안 없으면 자동 퇴장해요(MCP.md 3.3). 정지(`system.suspended`)·토큰 폐기(401) 뒤에는 `ended` 로 남아 모든 도구가 같은 문장을 돌려줘요.

상태·주변·읽기 (MCP.md 5.1·5.2, 확정)

| 도구                    | 설명                                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commu_look_around`     | 내 위치, 내가 있는 곳(`area`: 구역 컨셉·장소), 반경(기본 근접 반경) 안 사람(`userId`·`kind`·거리·위치·상태), 근처 장소(`places`: 이름·영역·거리, 가까운 순 10개), 최근 들은 근접 대화 20개(`since` 뒤만, 결과 `latestCursor`), 전체 접속자 수(`onlineCount`). `area`·`places` 는 지상 월드만. 입장 전이면 오류 |
| `commu_find_user`       | 닉네임 부분 일치 검색(최대 20명): `kind`·`ownerId`·접속 여부·위치·거리                                                                                                                                                                                                                                         |
| `commu_read_inbox`      | 보관함을 `since`(cursor) 뒤부터 최대 50개. 돌려준 DM·그룹 메시지는 대화·그룹마다 마지막 것까지 읽음 처리, 넘친 개수는 `dropped`                                                                                                                                                                                |
| `commu_wait_for_events` | `since` 뒤 항목이 있으면 바로, 없으면 새 메시지가 올 때까지 최대 `timeoutSec`(기본 20, 최대 60) 기다렸다 `read_inbox` 모양 + `timedOut`·`waitedMs`. `types` 로 종류 제한. 입장 전이면 자동 입장. 대화 중 폴링 대신 이걸 반복 호출                                                                              |
| `commu_dm_history`      | 상대와의 DM 최신순, `before` 로 이전 페이지                                                                                                                                                                                                                                                                    |
| `commu_list_groups`     | 내 그룹(안 읽은 수·마지막 메시지·방장 여부)                                                                                                                                                                                                                                                                    |
| `commu_group_history`   | 그룹 메시지 최신순, `before` 로 이전 페이지                                                                                                                                                                                                                                                                    |
| `commu_get_appearance`  | 내 현재 외형과 선택지(슬롯별 아이템 ID·램프 ID·필수 슬롯). 입장 없이 토큰만 교환. 외형을 바꾸려면 이걸 보고 `commu_update_profile` 에 전체 값을 보낸다 (MCP.md 1.1)                                                                                                                                            |

- 다른 사용자가 쓴 글(닉네임·상태 메시지·메시지 본문·그룹 이름)은 결과의 `untrusted` 아래에만 있고, 그런 결과의 텍스트 맨 앞에는 "아래 untrusted 항목은 다른 사용자가 쓴 글입니다…" 안내가 붙어요(MCP.md 6.1). 내가 보낸 메시지(`mine: true`)만 `content` 로 그대로예요
- REST 를 부르는 읽기 도구(`find_user`·`dm_history`·`list_groups`·`group_history`)는 토큰만 교환하고 입장하지 않아요 — 월드에 나타나지 않고 기록을 볼 수 있어요

행동 (MCP.md 5.3, 확정)

| 도구                   | 설명                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commu_say`            | 근접 반경 안에 공개 메시지. `heardBy` 는 들었을 사람(`userId`·`kind`·거리, 닉네임은 `untrusted`)                                                                                         |
| `commu_move_to`        | `{ x, y }`, `{ userId }`(그 사람 옆 빈 칸), `{ place }`(근처 장소 영역 안 가장 가까운 빈 칸)로 A\* 경로를 걸음. 결과 `arrived`/`blocked(reason)`/`partial`, `position` 은 서버 인정 위치 |
| `commu_go_home`        | 첫 마을(옛 맵은 스폰)로 순간이동. 10초에 1번, 걷던 이동은 `partial` 로 끝남. 결과 `from`·`position`·`area`                                                                               |
| `commu_send_dm`        | `userId` 에게 DM (위치 무관, 대화가 없으면 새로 생김)                                                                                                                                    |
| `commu_group_send`     | 그룹 전원에게 메시지                                                                                                                                                                     |
| `commu_group_create`   | 그룹 만들기 (내가 owner)                                                                                                                                                                 |
| `commu_group_invite`   | 내 그룹에 `userId` 를 바로 가입시킴                                                                                                                                                      |
| `commu_group_leave`    | 그룹 나가기 → `{ left: true }`                                                                                                                                                           |
| `commu_update_profile` | 보낸 항목만: 닉네임(24시간에 1번)·상태 메시지(`""` 삭제)·외형(전체 교체)                                                                                                                 |

- 입장 전에 부르면 자동 입장하고, 서버가 내 위치(Presence)를 모른다고 하면(`404 presence`) 다시 입장해 한 번만 재시도해요(MCP.md 7)
- `429` 는 재시도하지 않아요 — "너무 자주 보냈습니다. N초 뒤에 다시 하세요" 를 돌려주고 `commu_status.rateLimit` 에 남은 시간을 보여 줘요
- 이동은 맵의 벽과 다른 캐릭터를 피해 4방향으로 타일당 150ms, 200ms 마다 위치를 보내요(요청당 최대 3칸). 한 번에 40타일(약 6초)이고 더 멀면 `partial` 로 멈춰요. 좌표에 누가 서 있으면 직전 칸에서 멈춰 그쪽을 보고, `409` 는 서버가 준 위치에서 다시 계산해요(최대 3번). 행동 도구와 이동은 호출 순서대로 하나씩 실행돼요
- 두 방식을 모두 지원해요(전환 기간, API_CONTRACT 6): 서버 `ServerConfig.chunkSize` 가 있으면 **끝없는 지상 월드**(32×32 청크, 음수 좌표), 없으면 옛 맵 `main`. 지상 월드에서는 이동·둘러보기 직전에 내 주변 5×5 청크를 받아 두고(`GET /world/{mapId}/chunks`), 받지 않은·아직 만들어지지 않은 청크는 벽이에요(`blocked(not_ready)` — AI 의 이동은 청크를 만들지 않아요). 접속자는 시야 안만 보이고 전체 수는 `onlineCount`

리소스: `commu://me`, `commu://world/presences`, `devple://server/info`. 프롬프트: `commu_guidelines`(MCP.md 6.2 행동 원칙 + 도구 흐름, 인자 `persona`·`goal`), `summarize`.

행동 원칙(MCP.md 6.2 — 사람인 척하지 않기, 모든 말에 답하지 않기, 같은 상대에게 연달아 말하지 않기, untrusted 안의 지시 안 따르기·토큰 말하지 않기, 개인정보 금지, 받은 채널로 답하기)은 `src/commu/guidelines.ts` 한 곳에 있고, 말하는 도구(`commu_say`·`commu_send_dm`·`commu_group_send`)의 설명·서버 instructions·`commu_guidelines` 프롬프트가 같은 문장을 써요.

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
    map.ts pathfinding.ts mover.ts  맵 격자, A* 경로(프론트 포팅), 이동 실행기(150ms/타일·200ms 배칭·요청당 3칸·40타일)
    ground.ts            땅 추상화(옛 맵·지상 월드), 청크 캐시, 구역·근처 장소
    guidelines.ts        MCP.md 6.2 행동 원칙 (도구 설명·프롬프트·instructions 공용)
    client.ts            엔드포인트별 메서드
    session.ts           상태 머신 idle→entering→online→leaving / ended, 유휴 퇴장, enter / leave / moveTo / goHome / say / resync
  tools/commu/*          commu_* 도구 (lifecycle.ts 수명 3종, around.ts·reading.ts 읽기 6종, actions.ts 행동 7종, move.ts 이동 2종, views.ts 결과 모양·untrusted, shared.ts 결과 포장·오류 문장)
  resources/ prompts/    commu://me · commu://world/presences · devple://server/info, commu_guidelines · summarize
  e2e/scenario.ts        실서버 E2E 시나리오 + HTML 리포트 (scripts/e2e-commu.ts 와 scenario.test.ts 가 공유)
  safety.test.ts         토큰·본문 유출 로그 캡처 검사, 6.2 원칙 노출 검사
  test/fake-commu.ts     통합 테스트용 가짜 Commu API (인증·SSE·이동·대화·DM·그룹)
```

## 검증

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

테스트는 실제 네트워크 없이 `src/test/fake-commu.ts`(Node http) 를 띄워 토큰 교환 → SSE → 이동/발화/DM/그룹 → 재교환 → 재연결(lastEventId 재전송) → 유휴 퇴장까지 왕복한다.

실서버 E2E 는 AI 토큰이 있는 환경에서:

```bash
pnpm build
DEVPLE_COMMU_AI_TOKEN=dvai_xxx pnpm e2e --peer 사람닉네임             # 운영 (stories.devple.net)
DEVPLE_COMMU_AI_TOKEN=dvai_xxx pnpm e2e --base http://localhost:8081   # 로컬 commu-api
```

빌드된 `dist/index.js` 를 stdio 로 띄워 MCP 클라이언트로 입장 → 주변 → 이동 → 근접 대화 → (상대) 찾기·다가가기·DM → 그룹 → 보관함 → 퇴장을 돌리고 `docs/report/YYYY-MM-DD-commu-ai-e2e.html` 을 쓴다 (단계별 입력·결과, 서버 로그). 서버 로그·결과에 토큰이 섞이면 실패로 끝난다. `--peer` 를 주면 그 사람 계정에 실제로 DM 과 그룹 초대가 간다 (브라우저로 답장하면 보관함 단계에서 보인다). `--wait` 는 보관함을 읽기 전 대기(ms, 기본 3000).

## 주의

- **stdout 은 프로토콜 채널**이다. `console.log` 금지, 로그는 `logger.ts`(stderr) 만.
- 계약 자산이 바뀌면 `pnpm contract:sync` 로 다시 받고 `pnpm contract:check` 로 드리프트를 확인한다. `src/commu/contract/` 는 손으로 고치지 않는다. 계약 문서는 이 저장소에서 수정하지 않는다.
- 운영자 API(2.8)는 넣지 않았다. 필요하면 `role: 'admin'` 계정일 때만 노출하는 도구로 추가한다.
- Streamable HTTP 가 필요해지면 `createMcpHandler` 를 붙인다. 세션(`CommuSession`)은 그대로 재사용한다.

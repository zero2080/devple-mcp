// 실서버 E2E 시나리오 (ROADMAP C5·W6): 입장 → 주변 → 이동 → 마을 귀환 → (지상 월드면) 장소로 이동 → 근접 대화
// → (상대가 있으면) 찾기·다가가기·DM → 그룹 → 보관함 → 퇴장.
// MCP 클라이언트로 도구를 부르므로 LLM 이 쓰는 경로 그대로다. scripts/e2e-commu.ts 가 stdio 로 실서버에,
// scenario.test.ts 가 InMemoryTransport 로 가짜 서버에 돌린다. 결과는 renderReport 로 docs/report/ 의 HTML 이 된다.
import type { Client } from '@modelcontextprotocol/client';

type Data = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface ScenarioOptions {
  /** DM·초대 상대(사람 계정) 닉네임. 없으면 그 단계는 건너뛴다 */
  peer?: string;
  /** 보관함을 읽기 전에 기다리는 시간 (ms). 상대가 답장할 틈 */
  inboxWaitMs?: number;
  /** 그룹 이름·메시지에 붙는 표식 (기본 오늘 날짜) */
  label?: string;
  /** 메시지(say·DM·그룹)를 보내기 전 쉬는 시간 (ms). AI 전송 한도 2회/초(API_CONTRACT 1.4)를 넘지 않도록. 기본 600 */
  messagePauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type StepStatus = 'ok' | 'fail' | 'skip';

export interface StepRecord {
  name: string;
  tool?: string;
  args?: unknown;
  status: StepStatus;
  ms: number;
  /** structuredContent, 실패면 텍스트 */
  result?: unknown;
  note?: string;
}

export interface ScenarioResult {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  steps: StepRecord[];
  me: { id: string; nickname: string } | null;
  tools: string[];
}

/** MCP.md 5 의 20종 (1.1 외형 조회, 1.2 새 메시지 기다리기, 1.3 마을 귀환 포함) */
export const EXPECTED_TOOLS: readonly string[] = [
  'commu_enter',
  'commu_leave',
  'commu_status',
  'commu_look_around',
  'commu_find_user',
  'commu_read_inbox',
  'commu_wait_for_events',
  'commu_dm_history',
  'commu_list_groups',
  'commu_group_history',
  'commu_get_appearance',
  'commu_say',
  'commu_move_to',
  'commu_go_home',
  'commu_send_dm',
  'commu_group_send',
  'commu_group_create',
  'commu_group_invite',
  'commu_group_leave',
  'commu_update_profile',
];

const isObj = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (result: ToolResult): string =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');

export async function runScenario(
  client: Client,
  opts: ScenarioOptions = {},
): Promise<ScenarioResult> {
  const steps: StepRecord[] = [];
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const label = opts.label ?? new Date().toISOString().slice(0, 10);
  const messagePause = opts.messagePauseMs ?? 600;
  const startedAt = Date.now();
  let me: ScenarioResult['me'] = null;

  /** 도구 1회 호출 = 단계 1개. isError·예외·check 실패는 fail. 성공하면 structuredContent 를 돌려준다 */
  const call = async (
    name: string,
    tool: string,
    args: Data = {},
    check?: (data: Data) => string | undefined,
  ): Promise<Data | null> => {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } catch (error) {
      steps.push({
        name,
        tool,
        args,
        status: 'fail',
        ms: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const ms = Date.now() - started;
    const data = isObj(result.structuredContent) ? result.structuredContent : null;
    if (result.isError || data === null) {
      const text = textOf(result);
      steps.push({
        name,
        tool,
        args,
        status: 'fail',
        ms,
        result: text,
        note: result.isError ? (text.split('\n')[0] ?? '오류') : '구조화 결과 없음',
      });
      return null;
    }
    const note = check?.(data);
    steps.push({
      name,
      tool,
      args,
      status: note ? 'fail' : 'ok',
      ms,
      result: data,
      ...(note ? { note } : {}),
    });
    return note ? null : data;
  };
  const skip = (name: string, note: string): void => {
    steps.push({ name, status: 'skip', ms: 0, note });
  };
  const annotate = (note: string): void => {
    const last = steps[steps.length - 1];
    if (last) last.note = note;
  };

  // 1. 도구 목록
  const listed = Date.now();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  steps.push({
    name: '도구 목록 (MCP.md 5 의 20종)',
    status: missing.length === 0 ? 'ok' : 'fail',
    ms: Date.now() - listed,
    result: names.filter((n) => n.startsWith('commu_')),
    ...(missing.length > 0 ? { note: `없는 도구: ${missing.join(', ')}` } : {}),
  });

  // 2~4. 상태 → 외형(입장 없이) → 입장 → 주변
  await call('입장 전 상태', 'commu_status');
  await call('내 외형과 선택지 (입장 없이)', 'commu_get_appearance', {}, (d) =>
    isObj(d['current']) && isObj(d['options']) ? undefined : 'current·options 가 없음',
  );
  const entered = await call('입장 (토큰 교환 → SSE → 스냅샷)', 'commu_enter', {}, (d) =>
    isObj(d['me']) && typeof d['me']['id'] === 'string' ? undefined : 'me 가 없음',
  );
  if (entered && isObj(entered['me'])) {
    me = { id: String(entered['me']['id']), nickname: String(entered['me']['nickname']) };
  }
  await call('주변 보기', 'commu_look_around');

  // 5. 좌표로 이동: 내 위치에서 세 칸. 벽이면 다른 방향
  const position = entered && isObj(entered['position']) ? entered['position'] : null;
  if (position) {
    const x = Number(position['x']);
    const y = Number(position['y']);
    let arrived = false;
    const directions: ReadonlyArray<readonly [number, number]> = [
      [0, 3],
      [3, 0],
      [0, -3],
      [-3, 0],
    ];
    for (const [dx, dy] of directions) {
      const target = { x: x + dx, y: y + dy };
      const moved = await call(
        `좌표로 이동 (${String(target.x)}, ${String(target.y)})`,
        'commu_move_to',
        target,
      );
      if (!moved) break;
      if (moved['status'] === 'arrived') {
        arrived = true;
        break;
      }
      if (
        moved['status'] === 'blocked' &&
        (moved['reason'] === 'collision' || moved['reason'] === 'no_path')
      ) {
        annotate(`${String(moved['reason'])} — 다음 방향`);
        continue;
      }
      annotate(`status=${String(moved['status'])} reason=${String(moved['reason'] ?? '')}`);
      break;
    }
    if (!arrived)
      steps.push({
        name: '좌표 이동 결과',
        status: 'fail',
        ms: 0,
        note: '네 방향 모두 도착하지 못함',
      });
  } else {
    skip('좌표로 이동', '입장 결과에 위치가 없음');
  }

  // 5b. 마을 귀환 (지상 월드는 첫 마을, 옛 맵은 스폰) → 지상 월드면 근처 장소 중 가장 가까운 곳으로
  await call('마을 귀환', 'commu_go_home', {}, (d) =>
    isObj(d['position']) ? undefined : 'position 이 없음',
  );
  const around = await call('귀환 뒤 주변 보기', 'commu_look_around');
  const places = around && Array.isArray(around['places']) ? around['places'] : [];
  const nearest = places.find(isObj);
  if (nearest) {
    await call(
      `장소로 이동 (${String(nearest['name'])})`,
      'commu_move_to',
      { place: nearest['name'] },
      (d) =>
        d['status'] === 'arrived' ||
        d['status'] === 'partial' ||
        (d['status'] === 'blocked' && d['reason'] === 'no_free_tile')
          ? undefined
          : `status=${String(d['status'])} reason=${String(d['reason'] ?? '')}`,
    );
  }

  // 6. 근접 대화 (메시지 전송 전엔 한도 때문에 잠시 쉰다)
  await sleep(messagePause);
  await call(
    '근접 대화',
    'commu_say',
    { content: `안녕하세요! AI 계정 ${me?.nickname ?? ''} 의 연동 테스트예요.` },
    (d) => (isObj(d['message']) ? undefined : 'message 가 없음'),
  );

  // 7. 상대(사람): 찾기 → 옆으로 → 근접 대화 → DM → 히스토리
  let peer: { id: string; nickname: string } | null = null;
  if (opts.peer) {
    const found = await call(`사용자 찾기 "${opts.peer}"`, 'commu_find_user', {
      nickname: opts.peer,
    });
    const items = found && Array.isArray(found['items']) ? (found['items'] as Data[]) : [];
    const human =
      items.find((u) => u['kind'] === 'human' && u['online'] === true) ??
      items.find((u) => u['kind'] === 'human');
    if (human) {
      const untrusted = isObj(human['untrusted']) ? human['untrusted'] : {};
      peer = { id: String(human['userId']), nickname: String(untrusted['nickname'] ?? opts.peer) };
      if (human['online'] === true) {
        await call(`상대 옆으로 이동 (${peer.id})`, 'commu_move_to', { userId: peer.id }, (d) =>
          d['status'] === 'arrived'
            ? undefined
            : `status=${String(d['status'])} reason=${String(d['reason'] ?? '')}`,
        );
        await sleep(messagePause);
        await call('상대에게 근접 대화', 'commu_say', {
          content: `${peer.nickname} 님 안녕하세요, AI 계정이에요.`,
        });
      } else {
        skip('상대 옆으로 이동·근접 대화', `"${opts.peer}" 이(가) 접속 중이 아님`);
      }
      await sleep(messagePause);
      await call('DM 보내기', 'commu_send_dm', {
        userId: peer.id,
        content: `[E2E ${label}] AI 계정이 보낸 DM 이에요. 답장하면 보관함까지 확인돼요.`,
      });
      await call('DM 히스토리', 'commu_dm_history', { userId: peer.id, limit: 5 });
    } else {
      skip('상대 옆으로 이동·근접 대화·DM', `"${opts.peer}" 에 해당하는 사람 계정이 없음`);
    }
  } else {
    skip('사용자 찾기·상대 옆으로 이동·DM', '--peer 를 주지 않음');
  }

  // 8. 그룹: 만들기 → (상대) 초대 → 메시지 → 히스토리 → 목록
  const created = await call('그룹 만들기', 'commu_group_create', { name: `E2E ${label}` });
  const groupId = created && isObj(created['group']) ? String(created['group']['groupId']) : null;
  if (groupId) {
    if (peer) await call('그룹에 초대', 'commu_group_invite', { groupId, userId: peer.id });
    else skip('그룹에 초대', '상대 없음');
    await sleep(messagePause);
    await call('그룹 메시지', 'commu_group_send', {
      groupId,
      content: `[E2E ${label}] 그룹 메시지 테스트`,
    });
    await call('그룹 히스토리', 'commu_group_history', { groupId, limit: 5 });
    await call('내 그룹 목록', 'commu_list_groups');
  }

  // 9. 보관함: 상대가 답할 틈을 두고 읽은 뒤, 새 메시지 기다리기(long-poll)는 짧게 돌려 timedOut 또는 새 항목을 본다
  await sleep(opts.inboxWaitMs ?? 3000);
  const read = await call('보관함 읽기', 'commu_read_inbox', { limit: 50 });
  const since = read && typeof read['nextCursor'] === 'number' ? read['nextCursor'] : 0;
  await call('새 메시지 기다리기 (1초)', 'commu_wait_for_events', { since, timeoutSec: 1 }, (d) =>
    typeof d['timedOut'] === 'boolean' ? undefined : 'timedOut 이 없음',
  );

  // 10. 정리: 그룹 나가기 (마지막 멤버면 그룹이 사라진다)
  if (groupId) await call('그룹 나가기 (정리)', 'commu_group_leave', { groupId });

  // 11. 상태 → 퇴장 → 상태
  await call('입장 중 상태', 'commu_status', {}, (d) =>
    d['state'] === 'online' ? undefined : `state=${String(d['state'])}`,
  );
  await call('퇴장 (인사하고)', 'commu_leave', {
    farewell: '저는 이만 가 볼게요. 다음에 또 봐요!',
  });
  await call('퇴장 뒤 상태', 'commu_status', {}, (d) =>
    d['state'] === 'idle' ? undefined : `state=${String(d['state'])}`,
  );

  return {
    ok: steps.every((s) => s.status !== 'fail'),
    startedAt,
    finishedAt: Date.now(),
    steps,
    me,
    tools: names,
  };
}

/* ---------- 리포트 (docs/report/YYYY-MM-DD-commu-ai-e2e.html, 한국어·인라인 CSS) ---------- */

export interface ReportMeta {
  baseUrl: string;
  generatedAt: string;
  serverVersion: string | null;
  /** MCP 서버 stderr (호출자가 토큰을 점검한 뒤 넘긴다) */
  log: string;
  /** 로그·결과에 토큰이 있었는지 */
  tokenLeaked: boolean;
}

const escapeHtml = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const json = (value: unknown): string => escapeHtml(JSON.stringify(value, null, 2));

const STATUS_LABEL: Record<StepStatus, string> = { ok: '통과', fail: '실패', skip: '건너뜀' };

export function renderReport(result: ScenarioResult, meta: ReportMeta): string {
  const passed = result.ok && !meta.tokenLeaked;
  const counts = {
    ok: result.steps.filter((s) => s.status === 'ok').length,
    fail: result.steps.filter((s) => s.status === 'fail').length,
    skip: result.steps.filter((s) => s.status === 'skip').length,
  };
  const rows = result.steps
    .map(
      (s, i) =>
        `<tr class="${s.status}"><td>${String(i + 1)}</td><td>${escapeHtml(s.name)}</td><td><code>${escapeHtml(s.tool ?? '')}</code></td>` +
        `<td class="st">${STATUS_LABEL[s.status]}</td><td class="num">${String(s.ms)}</td><td>${escapeHtml(s.note ?? '')}</td></tr>`,
    )
    .join('\n');
  const details = result.steps
    .map(
      (s, i) =>
        `<details${s.status === 'fail' ? ' open' : ''}><summary>${String(i + 1)}. ${escapeHtml(s.name)} — ${STATUS_LABEL[s.status]}</summary>` +
        (s.args !== undefined ? `<p>입력</p><pre>${json(s.args)}</pre>` : '') +
        (s.result !== undefined ? `<p>결과</p><pre>${json(s.result)}</pre>` : '') +
        (s.note ? `<p>비고: ${escapeHtml(s.note)}</p>` : '') +
        `</details>`,
    )
    .join('\n');
  const logLines = meta.log.split('\n').filter((l) => l.trim() !== '');
  const logTail = logLines.slice(-200).join('\n');
  const duration = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Commu AI 계정 E2E — ${escapeHtml(meta.generatedAt.slice(0, 10))}</title>
<style>
  body { font: 15px/1.6 -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: #1f2328; margin: 0 auto; max-width: 960px; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; } h2 { font-size: 17px; margin: 32px 0 8px; }
  .lead { font-size: 17px; } .pass { color: #0a7f3f; } .failc { color: #b42318; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; } th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; } tr.ok .st { color: #0a7f3f; } tr.fail .st { color: #b42318; font-weight: 600; } tr.skip td { color: #656d76; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; } pre { background: #f6f8fa; padding: 10px; overflow: auto; border-radius: 6px; }
  details { border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 10px; margin: 6px 0; } summary { cursor: pointer; }
  .meta td:first-child { width: 160px; color: #656d76; }
</style>
</head>
<body>
<h1>Commu AI 계정 E2E 리포트</h1>
<p class="lead">결과: <b class="${passed ? 'pass' : 'failc'}">${passed ? '통과' : '실패'}</b> —
단계 ${String(result.steps.length)} (통과 ${String(counts.ok)} · 실패 ${String(counts.fail)} · 건너뜀 ${String(counts.skip)}),
토큰 유출 점검: <b class="${meta.tokenLeaked ? 'failc' : 'pass'}">${meta.tokenLeaked ? '있음 (로그·결과에 토큰이 보임)' : '없음'}</b></p>
<table class="meta">
<tr><td>서버</td><td>${escapeHtml(meta.baseUrl)}</td></tr>
<tr><td>MCP 서버 버전</td><td>${escapeHtml(meta.serverVersion ?? '?')}</td></tr>
<tr><td>AI 계정</td><td>${result.me ? `${escapeHtml(result.me.nickname)} (<code>${escapeHtml(result.me.id)}</code>)` : '입장 실패'}</td></tr>
<tr><td>실행</td><td>${escapeHtml(meta.generatedAt)} · ${duration}초</td></tr>
<tr><td>시나리오</td><td>ROADMAP C5 — 입장 → 주변 → 이동 → 근접 대화 → 상대 찾기·다가가기·DM → 그룹 → 보관함 → 퇴장 (MCP 클라이언트로 도구 호출)</td></tr>
</table>

<h2>단계</h2>
<table>
<tr><th>#</th><th>단계</th><th>도구</th><th>결과</th><th>ms</th><th>비고</th></tr>
${rows}
</table>

<h2>상세 (입력·결과)</h2>
${details}

<h2>MCP 서버 로그 (stderr, 마지막 ${String(Math.min(200, logLines.length))}줄 / 전체 ${String(logLines.length)}줄)</h2>
<pre>${escapeHtml(logTail)}</pre>
</body>
</html>
`;
}

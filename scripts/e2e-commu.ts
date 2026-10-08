// 실서버 E2E (ROADMAP C5). 빌드된 dist/index.js 를 stdio 로 띄워 LLM 과 같은 경로(MCP 클라이언트)로 도구를 부르고
// docs/report/YYYY-MM-DD-commu-ai-e2e.html 을 쓴다. 시나리오는 src/e2e/scenario.ts (가짜 서버 테스트와 공유).
//
//   DEVPLE_COMMU_AI_TOKEN=dvai_… pnpm e2e [--base http://localhost:8081] [--peer 닉네임] [--out 경로] [--wait 3000]
//
// 토큰은 환경변수로만 받고 어디에도 쓰지 않는다. 서버 로그·결과에 토큰이 섞이면 실패로 끝낸다.
// (이 스크립트는 MCP 서버가 아니라 별도 프로세스라 stdout 에 요약을 찍어도 된다)
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { renderReport, runScenario } from '../src/e2e/scenario.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    peer: { type: 'string' },
    out: { type: 'string' },
    wait: { type: 'string' },
  },
});

const token = process.env['DEVPLE_COMMU_AI_TOKEN']?.trim();
if (!token) {
  console.error(
    'DEVPLE_COMMU_AI_TOKEN 이 필요해요 (Commu 프로필 카드 › 내 AI 에서 발급). 예: DEVPLE_COMMU_AI_TOKEN=dvai_… pnpm e2e --peer 닉네임',
  );
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist', 'index.js');
if (!existsSync(dist)) {
  console.error('dist/index.js 가 없어요. 먼저 pnpm build.');
  process.exit(2);
}

const baseUrl = (
  values.base?.trim() ||
  process.env['DEVPLE_COMMU_BASE_URL']?.trim() ||
  'https://stories.devple.net'
).replace(/\/+$/, '');
const now = new Date();
const stamp = now.toISOString().slice(0, 10);
const out = path.resolve(root, values.out ?? `docs/report/${stamp}-commu-ai-e2e.html`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [dist],
  cwd: root,
  env: {
    ...getDefaultEnvironment(),
    DEVPLE_COMMU_AI_TOKEN: token,
    DEVPLE_COMMU_BASE_URL: baseUrl,
    DEVPLE_MCP_LOG_LEVEL: 'debug',
  },
  stderr: 'pipe',
});
let log = '';
transport.stderr?.on('data', (chunk: Buffer) => {
  log += chunk.toString('utf8');
});

const client = new Client({ name: 'devple-mcp-e2e', version: '0.0.0' });
await client.connect(transport);
const serverVersion = client.getServerVersion()?.version ?? null;
const result = await runScenario(client, {
  ...(values.peer ? { peer: values.peer } : {}),
  label: stamp,
  inboxWaitMs: Number(values.wait ?? 3000),
});
await client.close();

const tokenLeaked = `${log}\n${JSON.stringify(result)}`.includes(token);
const html = renderReport(result, {
  baseUrl,
  generatedAt: now.toISOString(),
  serverVersion,
  log,
  tokenLeaked,
});
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, html, 'utf8');

const mark = { ok: '✓', fail: '✗', skip: '–' } as const;
for (const [i, step] of result.steps.entries()) {
  const tool = step.tool ? ` (${step.tool})` : '';
  const note = step.note ? ` — ${step.note}` : '';
  console.log(`${String(i + 1).padStart(2)} ${mark[step.status]} ${step.name}${tool}${note}`);
}
const passed = result.ok && !tokenLeaked;
console.log(
  `\n${passed ? '통과' : '실패'} · 서버 ${baseUrl} · 리포트 ${path.relative(root, out)} · 토큰 유출 ${tokenLeaked ? '있음!' : '없음'}`,
);
process.exit(passed ? 0 : 1);

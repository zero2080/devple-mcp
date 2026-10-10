// 계약 자산 동기화 (docs/commu/ARCHITECTURE.md 8장, MCP.md 8).
// 프론트 저장소의 원본을 src/commu/contract/ 로 복사하고 SOURCE.json 에 원본 커밋·sha256 을 적는다.
// 복사본은 손으로 고치지 않는다 — 이 파일의 변환(상대 import 에 .js 붙이기)만 거친다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_FRONTEND_DIR = '../devple-ai-commu';
export const CONTRACT_DIR = 'src/commu/contract';

/** 원본(프론트 저장소 기준 경로) → 사본(CONTRACT_DIR 기준 경로) */
export interface ContractFile {
  source: string;
  target: string;
}

export interface SourceManifest {
  repository: string;
  commit: string;
  dirty: boolean;
  syncedAt: string;
  /** 원본 경로 → 원본 sha256 (변환 전) */
  files: Record<string, string>;
}

export interface SyncFileResult extends ContractFile {
  status: 'same' | 'written' | 'drift';
}

export interface SyncResult {
  commit: string;
  dirty: boolean;
  files: SyncFileResult[];
  /** check 모드에서 원본과 다른 사본 (또는 SOURCE.json 불일치) */
  drift: string[];
}

export class ContractSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractSyncError';
  }
}

/** 동기화 대상 목록. 스키마 디렉토리는 *.ts 전부(테스트 제외) */
export function listContractFiles(frontendDir: string): ContractFile[] {
  const schemasDir = path.join(frontendDir, 'src/transport/schemas');
  if (!existsSync(schemasDir)) {
    throw new ContractSyncError(`프론트 저장소를 찾을 수 없어요: ${path.resolve(frontendDir)}`);
  }
  const schemas = readdirSync(schemasDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({ source: `src/transport/schemas/${name}`, target: `schemas/${name}` }));
  return [
    { source: 'src/domain/types.ts', target: 'types.ts' },
    ...schemas,
    { source: 'src/assets/maps/main.json', target: 'maps/main.json' },
    { source: 'src/assets/world/terrain.json', target: 'world/terrain.json' },
  ];
}

const RELATIVE_IMPORT = /(from\s+|import\s+|export\s+\*\s+from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;
const ALIAS_IMPORT = /(['"])@\/[^'"]+\1/;

/**
 * 프론트는 bundler 해석(확장자 없음)이고 이 저장소는 NodeNext(ESM) 라 상대 import 에 .js 를 붙인다.
 * 프론트 내부 별칭(@/…)은 자족적이지 않으므로 실패시킨다 (to-code 로 알린다 — ARCHITECTURE 8).
 */
export function transformSource(source: string, file: string): string {
  if (!file.endsWith('.ts')) return source;
  if (ALIAS_IMPORT.test(source)) {
    throw new ContractSyncError(
      `${file} 가 프론트 내부 별칭(@/…)을 import 해요. 프론트가 스키마를 자족적으로 바꿔야 해요 (to-code).`,
    );
  }
  return source.replace(RELATIVE_IMPORT, (_m, head: string, quote: string, spec: string) => {
    const hasExt = /\.(js|mjs|cjs|json|ts)$/.test(spec);
    return `${head}${quote}${hasExt ? spec : `${spec}.js`}${quote}`;
  });
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(frontendDir: string, args: string[]): string {
  return execFileSync('git', ['-C', frontendDir, ...args], { encoding: 'utf8' }).trim();
}

export interface RunSyncOptions {
  repoRoot: string;
  frontendDir: string;
  check?: boolean;
  now?: () => Date;
}

export async function runSync(options: RunSyncOptions): Promise<SyncResult> {
  const frontendDir = path.resolve(options.repoRoot, options.frontendDir);
  const contractRoot = path.join(options.repoRoot, CONTRACT_DIR);
  const files = listContractFiles(frontendDir);

  const commit = git(frontendDir, ['rev-parse', 'HEAD']);
  const dirty =
    git(frontendDir, ['status', '--porcelain', '--', ...files.map((f) => f.source)]).length > 0;

  const manifestPath = path.join(contractRoot, 'SOURCE.json');
  const previous: SourceManifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as SourceManifest)
    : null;

  const manifest: SourceManifest = {
    repository: 'devple-ai-commu',
    commit,
    dirty,
    syncedAt: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    files: {},
  };
  const results: SyncFileResult[] = [];
  const drift: string[] = [];

  for (const file of files) {
    const original = readFileSync(path.join(frontendDir, file.source));
    const transformed = transformSource(original.toString('utf8'), file.source);
    manifest.files[file.source] = sha256(original);

    const targetPath = path.join(contractRoot, file.target);
    const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
    const same =
      current === transformed && previous?.files[file.source] === manifest.files[file.source];

    if (options.check) {
      results.push({ ...file, status: same ? 'same' : 'drift' });
      if (!same) drift.push(file.target);
      continue;
    }
    if (current !== transformed) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, transformed);
    }
    results.push({ ...file, status: current === transformed ? 'same' : 'written' });
  }

  if (!options.check) {
    mkdirSync(contractRoot, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (previous === null) {
    drift.push('SOURCE.json');
  }

  return { commit, dirty, files: results, drift };
}

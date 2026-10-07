// scripts/sync-commu-contract.sh 가 실행한다. 로직은 src/commu/contract-sync.ts (테스트에서도 같은 코드를 쓴다).
import path from 'node:path';

import { ContractSyncError, DEFAULT_FRONTEND_DIR, runSync } from '../src/commu/contract-sync.js';

const args = process.argv.slice(2);
let frontendDir = DEFAULT_FRONTEND_DIR;
let check = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--check') check = true;
  else if (arg === '--frontend' && args[i + 1]) frontendDir = args[++i]!;
  else {
    process.stderr.write(`알 수 없는 인자: ${arg}\n`);
    process.exit(2);
  }
}

try {
  const result = await runSync({ repoRoot: process.cwd(), frontendDir, check });
  const mode = check ? 'check' : 'sync';
  process.stderr.write(
    `[contract ${mode}] ${path.resolve(frontendDir)} @ ${result.commit.slice(0, 7)}${result.dirty ? ' (dirty)' : ''}\n`,
  );
  for (const file of result.files) {
    const mark = file.status === 'same' ? ' ' : file.status === 'written' ? '+' : '!';
    process.stderr.write(`  ${mark} ${file.target}  ←  ${file.source}\n`);
  }
  if (check && result.drift.length > 0) {
    process.stderr.write(
      `\n원본과 다른 파일 ${result.drift.length}개. scripts/sync-commu-contract.sh 를 실행하세요.\n`,
    );
    process.exit(1);
  }
} catch (error) {
  if (error instanceof ContractSyncError) {
    process.stderr.write(`[contract] ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

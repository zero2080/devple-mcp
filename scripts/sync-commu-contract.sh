#!/usr/bin/env bash
# 프론트 저장소(devple-ai-commu)의 계약 자산을 src/commu/contract/ 로 복사한다 (docs/commu/ARCHITECTURE.md 8장).
#   scripts/sync-commu-contract.sh                 # ../devple-ai-commu 에서 동기화
#   scripts/sync-commu-contract.sh --frontend DIR  # 다른 위치의 프론트 저장소
#   scripts/sync-commu-contract.sh --check         # 쓰지 않고 원본·사본·SOURCE.json 이 일치하는지만 확인
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm exec tsx scripts/sync-commu-contract.ts "$@"

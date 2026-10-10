import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTRACT_DIR, DEFAULT_FRONTEND_DIR, runSync, transformSource } from './contract-sync.js';
import mainMap from './contract/maps/main.json' with { type: 'json' };
import * as contract from './contract/schemas/index.js';
import source from './contract/SOURCE.json' with { type: 'json' };
import { mapGridSchema } from './schemas.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const frontendDir = path.resolve(repoRoot, DEFAULT_FRONTEND_DIR);

describe('계약 자산 (src/commu/contract)', () => {
  it('맵 자산이 격자 스키마에 맞고 collision 크기가 width*height 다', () => {
    const grid = mapGridSchema.parse(mainMap);
    expect(grid.id).toBe('main');
    expect(grid.collision).toHaveLength(grid.width * grid.height);
    expect(grid.collision[grid.spawn.y * grid.width + grid.spawn.x]).toBe(0);
  });

  it('스키마 사본이 로드되고 샘플을 파싱한다', () => {
    expect(contract.positionSchema.parse({ mapId: 'main', x: 1, y: 2, dir: 'up' })).toEqual({
      mapId: 'main',
      x: 1,
      y: 2,
      dir: 'up',
    });
    expect(contract.SSE_EVENT_TYPES).toContain('world.snapshot');
    expect(contract.API_ERROR_CODES).toContain('POSITION_REJECTED');
  });

  it('SOURCE.json 에 동기화 대상 전부의 원본 sha256 이 있다', () => {
    const schemas = readdirSync(path.join(repoRoot, CONTRACT_DIR, 'schemas'));
    const expected = [
      'src/domain/types.ts',
      'src/assets/maps/main.json',
      'src/assets/world/terrain.json',
      ...schemas.map((name) => `src/transport/schemas/${name}`),
    ].sort();
    expect(Object.keys(source.files).sort()).toEqual(expected);
    for (const hash of Object.values(source.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('transformSource 는 상대 import 에 .js 를 붙이고 프론트 별칭은 거부한다', () => {
    const out = transformSource(
      "import { a } from './common';\nexport * from './world';\nimport { z } from 'zod';\nimport x from './data.json';\n",
      'x.ts',
    );
    expect(out).toBe(
      "import { a } from './common.js';\nexport * from './world.js';\nimport { z } from 'zod';\nimport x from './data.json';\n",
    );
    expect(() => transformSource("import { t } from '@/domain';", 'y.ts')).toThrow(/@\//);
    expect(transformSource('{"a":1}', 'm.json')).toBe('{"a":1}');
  });

  it.skipIf(!existsSync(frontendDir))(
    '형제 저장소가 있으면 원본·사본·SOURCE.json 이 일치한다',
    async () => {
      const result = await runSync({ repoRoot, frontendDir: DEFAULT_FRONTEND_DIR, check: true });
      expect(result.drift).toEqual([]);
    },
  );
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { DEVPLE_MCP_LOG_LEVEL: 'error' },
    include: ['src/**/*.test.ts'],
  },
});

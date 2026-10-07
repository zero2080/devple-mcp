#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadCommuConfig } from './commu/config.js';
import { CommuSession } from './commu/session.js';
import { log } from './logger.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';
import { createServer } from './server.js';

const config = loadCommuConfig();
const session = new CommuSession(config);

const handle = serveStdio(() => createServer({ session }), {
  onerror: (error) => log.error('transport error', error),
});

log.info(
  `${SERVER_NAME} v${SERVER_VERSION} listening on stdio (commu: ${config.apiBaseUrl}, token: ${config.enabled ? 'set' : 'missing'})`,
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);
  try {
    await session.leave('shutdown');
  } catch (error) {
    log.warn('disconnect failed', error);
  }
  await handle.close();
  process.exit(0);
}

process.once('SIGINT', (s) => void shutdown(s));
process.once('SIGTERM', (s) => void shutdown(s));

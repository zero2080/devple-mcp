/**
 * stdio 트랜스포트에서는 stdout 이 MCP 프로토콜 채널이라 로그는 반드시 stderr 로만 보낸다.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const raw = (process.env['DEVPLE_MCP_LOG_LEVEL'] ?? 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function write(level: Level, message: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta === undefined) {
    process.stderr.write(`${line}\n`);
    return;
  }
  const detail = meta instanceof Error ? (meta.stack ?? meta.message) : JSON.stringify(meta);
  process.stderr.write(`${line} ${detail}\n`);
}

export const log = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};

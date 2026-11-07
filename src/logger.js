/**
 * BypassX Deobf Bot — minimal dependency-free structured logger
 * with an in-memory ring buffer for the owner-only `.logs` command.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

const RING_MAX = 300;
const ring = [];

function emit(level, obj, msg) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  const line = obj
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(obj)}`
    : `[${ts}] ${level.toUpperCase()} ${msg}`;
  console.log(line);
  ring.push(line.slice(0, 300));
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

export const logger = {
  debug: (obj, msg) => emit('debug', obj, msg),
  info: (obj, msg) => emit('info', obj, msg),
  warn: (obj, msg) => emit('warn', obj, msg),
  error: (obj, msg) => emit('error', obj, msg),
};

/** Last n log lines (oldest → newest). */
export function recentLogs(n = 30) {
  return ring.slice(-Math.max(1, Math.min(n, RING_MAX)));
}

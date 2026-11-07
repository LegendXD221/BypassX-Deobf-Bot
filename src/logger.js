/**
 * BypassX Deobf Bot — minimal dependency-free structured logger.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

function emit(level, obj, msg) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  if (obj) console.log(`[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(obj)}`);
  else console.log(`[${ts}] ${level.toUpperCase()} ${msg}`);
}

export const logger = {
  debug: (obj, msg) => emit('debug', obj, msg),
  info: (obj, msg) => emit('info', obj, msg),
  warn: (obj, msg) => emit('warn', obj, msg),
  error: (obj, msg) => emit('error', obj, msg),
};

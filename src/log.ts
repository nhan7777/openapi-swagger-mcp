import { sanitizeMessage } from './util.js';

type Meta = Record<string, string | number | boolean | undefined>;

/** Operational logging to stderr only. Never pass bodies, headers or credentials here. */
function emit(level: string, msg: string, meta?: Meta): void {
  const line = JSON.stringify({ level, msg: sanitizeMessage(msg), ...(meta ?? {}) });
  process.stderr.write(line + '\n');
}
export const log = {
  info: (msg: string, meta?: Meta) => emit('info', msg, meta),
  warn: (msg: string, meta?: Meta) => emit('warn', msg, meta),
  error: (msg: string, meta?: Meta) => emit('error', msg, meta),
};

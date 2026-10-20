/**
 * Small structured JSON logger.
 *
 * Secrets never belong in logs: any key listed in REDACT is replaced, at any
 * depth, before a line is written. Message content is not logged either —
 * only ids and sizes — to keep stored personal data to a minimum.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Any key matching this is redacted, at any depth (case-insensitive, partial match). */
const REDACT = /pass(word|wd)?|token|secret|session|creds|^keys?$|dek|blob|authorization|cookie|pairing|^qr$|phone|^text$|caption|email|wrapped/i;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}b>`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info',
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact({ ...base, ...fields }) as object) }));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, minLevel, sink),
  };
}

/** A logger that writes nothing — used in tests. */
export const silentLogger: Logger = createLogger({}, 'error', () => {});

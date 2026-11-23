/**
 * Structured logging with secret redaction (ARCHITECTURE.md §14.3, CLAUDE.md
 * safety rule 7). Field values whose key looks secret are replaced, and
 * credential-bearing URL parts are stripped from every string.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const SECRET_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|session|csrf|api[-_]?key|credential/i;
export const REDACTED = "[redacted]";

function redactString(s: string): string {
  return s
    // userinfo in URLs: https://user:pass@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    // secret-looking query parameters
    .replace(
      /([?&](?:token|key|api_key|apikey|secret|password|access_token|client_secret|sig|signature)=)[^&\s#]*/gi,
      `$1${REDACTED}`,
    );
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return redactString(value.message);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function createLogger(
  level: LogLevel = "info",
  sink: (line: string) => void = (l) => console.log(l),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = {
      time: new Date().toISOString(),
      level: lvl,
      msg: redactString(msg),
      ...(redact(fields ?? {}) as LogFields),
    };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** Discards everything; for tests. */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

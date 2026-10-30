import { config } from './config.js';

type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|api[-_]?key|credential|session)/i;
const MAX_STRING = 400;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: string }).code };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(raw, depth + 1);
  }
  return out;
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(meta ? (redactValue(meta, 0) as Record<string, unknown>) : {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'app'): Logger {
  return {
    error: (message, meta) => emit('error', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    debug: (message, meta) => emit('debug', scope, message, meta),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export const logger = createLogger();

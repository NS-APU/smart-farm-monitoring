/**
 * 構造化ログ（JSON）のロガー。1行1イベントで出力する（NFR-6.3）。
 * 秘密情報・個人情報・リクエスト本文の全体は、出力しない。秘密情報らしい名前のフィールドは、値をマスクする。
 * `console.log` を直接使わず、このロガーを使う（coding-standards.md）。
 */

import type { LogFields, Logger } from '../../application/ports/logger-port.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const MASKED_VALUE = '[MASKED]';
const SENSITIVE_FIELD_PATTERN =
  /password|secret|token|authorization|credential|cookie|apikey|api_key/i;

export interface LogSink {
  write(line: string): void;
}

/** ネストしたオブジェクトを、たどる深さの上限（循環・巨大な値で、ログの出力が止まらないように）。 */
const MAX_DEPTH = 6;
const CIRCULAR_VALUE = '[Circular]';
const TRUNCATED_VALUE = '[Truncated]';

/**
 * ログに出せる値にする: 秘密情報らしい名前のキーは、ネストしていても値をマスクする。
 * 循環参照・BigInt・Error・Date など、JSON にできない値は、文字列などへ置き換える（ログの出力で例外を出さない。V-069）。
 */
function sanitize(value: unknown, ancestors: readonly object[], depth: number): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.includes(value)) {
    return CIRCULAR_VALUE;
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED_VALUE;
  }
  const path = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, path, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_FIELD_PATTERN.test(key)
      ? MASKED_VALUE
      : sanitize(child, path, depth + 1);
  }
  return result;
}

export function maskSensitiveFields(fields: LogFields): LogFields {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    masked[key] = SENSITIVE_FIELD_PATTERN.test(key) ? MASKED_VALUE : sanitize(value, [fields], 1);
  }
  return masked;
}

export function createJsonLogger(options: {
  readonly sink: LogSink;
  readonly minimumLevel?: LogLevel;
  readonly now?: () => Date;
  readonly bindings?: LogFields;
}): Logger {
  const minimumLevel = options.minimumLevel ?? 'info';
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  function write(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) {
      return;
    }
    const time = now().toISOString();
    let line: string;
    try {
      line = JSON.stringify({
        time,
        level,
        message,
        ...maskSensitiveFields({ ...bindings, ...fields }),
      });
    } catch {
      // 値の取得で例外を投げるプロパティ（getter）などは、JSON にできない。ロガーの失敗で、呼び出し元の処理を止めない
      line = JSON.stringify({ time, level, message, fields: '[UNSERIALIZABLE]' });
    }
    options.sink.write(`${line}\n`);
  }

  return {
    debug: (message, fields) => {
      write('debug', message, fields);
    },
    info: (message, fields) => {
      write('info', message, fields);
    },
    warn: (message, fields) => {
      write('warn', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
    child: (fields) => createJsonLogger({ ...options, bindings: { ...bindings, ...fields } }),
  };
}

/** 標準出力へ書くシンク（Lambda・ローカルのサーバー用）。 */
export const STDOUT_SINK: LogSink = {
  write: (line) => {
    process.stdout.write(line);
  },
};

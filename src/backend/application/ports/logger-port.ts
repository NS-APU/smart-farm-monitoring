/**
 * ロガーのポート。構造化ログ（JSON）で出力する（NFR-6.3）。
 * 秘密情報・個人情報・リクエスト本文の全体は、フィールドに含めない（security.md）。
 */

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** 固定のフィールド（リクエストの識別子など）を持つロガーを作る。 */
  child(fields: LogFields): Logger;
}

/** 何も出力しないロガー（テスト用の既定）。 */
const noop = (): void => undefined;

export const NULL_LOGGER: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => NULL_LOGGER,
};

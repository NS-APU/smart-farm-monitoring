/** テストで使う定数（合成データ）。アプリ全体の組み立て（test-context.ts）に依存せずに使えるよう、分けている。 */

export const TEST_USER = {
  userId: 'test-user',
  userName: 'テストユーザー',
  password: 'Dummy-Passw0rd-test',
} as const;

/** 固定する現在時刻（日本時間 2026-10-09 12:00）。 */
export const TEST_NOW = new Date('2026-10-09T03:00:00Z');

/**
 * ファイルサーバーのスタブのファイルの更新日時。固定した時計（TEST_NOW）の 1 分前。
 * 更新日時が 1 秒以内のファイルは、書き換えの最中かもしれないため、読まずに次の周期に回す（ADR-0016 の D-08）。
 * 時計と同じ時刻にすると、回されてしまう。
 */
export const STUB_MODIFIED_AT = new Date(TEST_NOW.getTime() - 60_000);

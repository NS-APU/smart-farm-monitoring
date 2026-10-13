/** テストで使う定数（合成データ）。アプリ全体の組み立て（test-context.ts）に依存せずに使えるよう、分けている。 */

export const TEST_USER = {
  userId: 'test-user',
  userName: 'テストユーザー',
  password: 'Dummy-Passw0rd-test',
} as const;

/** 固定する現在時刻（日本時間 2026-10-09 12:00）。 */
export const TEST_NOW = new Date('2026-10-09T03:00:00Z');

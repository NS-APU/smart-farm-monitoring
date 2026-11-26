/**
 * ログ類の保存期間（ADR-0018 の D-30。Issue #230）。取り込みログ・連携ログ・送信済みの連携項目は、日時から 90 日で消す。
 * 評価の長期視点の最大（90 日）と、そろえる。DynamoDB 実装は、TTL の値（`ttl`。エポック秒）で消し、
 * ローカル実装は、同じ期限で、読み書きのときに消す。
 */

/** 保存期間（日）。 */
export const LOG_RETENTION_DAYS = 90;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function expiresAtMs(occurredAt: string): number {
  return Date.parse(occurredAt) + LOG_RETENTION_DAYS * MILLISECONDS_PER_DAY;
}

/** DynamoDB の TTL の値（`occurredAt` の 90 日後。エポック秒。ミリ秒の端数は、切り上げる）。 */
export function logTtlSeconds(occurredAt: string): number {
  return Math.ceil(expiresAtMs(occurredAt) / 1000);
}

/** 期限（`occurredAt` の 90 日後）の時刻に、達しているか。 */
export function isLogExpired(occurredAt: string, now: Date): boolean {
  return expiresAtMs(occurredAt) <= now.getTime();
}

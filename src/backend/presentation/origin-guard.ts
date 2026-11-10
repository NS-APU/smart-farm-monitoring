/**
 * オリジンの検証（Issue #102。ADR-0010 の追記）。API の Lambda の関数の URL は、認証なしで公開され、CloudFront を経由せずに、直接も呼べる。
 * CloudFront が、オリジンへの呼び出しに、秘密のヘッダー（ORIGIN_SECRET_HEADER）を付け、API が、値を検証する。
 * 一致しない呼び出し（直接の呼び出し）は、本文なしの 403 で拒否する。これにより、CloudFront の Function が入れる利用者の IP のヘッダー
 * （CLIENT_IP_HEADER）は、CloudFront を経由した呼び出しにだけ届き、直接の呼び出しで偽装して、ログインの試行回数の制限（接続元ごと）を回避できない。
 *
 * - 秘密の値は、IaC が Secrets Manager に自動生成し、CloudFront のヘッダーに入れる。API の Lambda は、環境変数の ARN（ORIGIN_VERIFY_ARN。
 *   秘密の値ではない）で、コールドスタートの 1 回だけ、Secrets Manager から読む（lambda.ts。秘密の値を、Lambda の設定に持たない）。
 *   ローカル・テストでは、環境変数 ORIGIN_VERIFY_SECRET で、値を直接、渡せる（Lambda では、使えない）。
 *   リポジトリには、書かない。ログ・応答・エラーに、値（設定の値・送られた値）を含めない
 * - 秘密が未設定（ローカルの Node サーバー・E2E）のときは、検証しない
 * - 比較は、定数時間（値の長さ・一致の長さを、応答の時間から推測されない）
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../application/ports/logger-port.ts';
import type { AppEnv } from './api-deps.ts';

/** CloudFront が、オリジンに付ける秘密のヘッダーの名前（小文字。インフラ・テストと同じ値を使う）。 */
export const ORIGIN_SECRET_HEADER = 'x-sfm-origin-secret';

/** 秘密の値の形式（英数字 32〜128 文字。IaC の自動生成は、英数字 64 文字）。設定・Secrets Manager から読んだ値の検証に使う。 */
export const ORIGIN_SECRET_PATTERN = /^[A-Za-z0-9]{32,128}$/;

/** 値を、同じ長さ（SHA-256）にして、定数時間で比べる（長さの違いからも、推測されないようにする）。 */
function matches(expected: string, actual: string | undefined): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return actual !== undefined && timingSafeEqual(digest(expected), digest(actual));
}

export function originGuard(secret: string, logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!matches(secret, c.req.header(ORIGIN_SECRET_HEADER))) {
      // 値は、記録しない（設定の値も、送られた値も）。拒否したことと、パスだけ
      logger.warn('オリジンの検証に失敗したため、呼び出しを拒否しました', { path: c.req.path });
      return c.body(null, 403);
    }
    await next();
    return undefined;
  };
}

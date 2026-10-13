/**
 * 接続元の識別（ログインの試行回数の制限に使う）。
 * - `X-Forwarded-For` は、クライアントが自由に付けられるため、既定では信頼しない。
 *   信頼するプロキシの段数（`TRUSTED_PROXY_HOPS`）を指定した場合だけ、末尾から数えた値（信頼するプロキシが付けた値）を使う
 *   （先頭の値は、クライアントの申告のため使わない。V-007）。
 * - 接続元は、実行形態ごとに取り方が異なる: Node サーバーは、接続情報（conninfo）、Lambda は、イベントの `sourceIp`。
 *   取得できない場合は undefined（呼び出し側が、ユーザーID単位に切り替える。V-008）。
 */

import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { AppEnv } from './api-deps.ts';

/** Lambda（関数の URL・HTTP API。ペイロード形式 2.0 と、REST API の 1.0）のイベントの接続元。 */
const LambdaEnvSchema = z.object({
  event: z.object({
    requestContext: z.object({
      http: z.object({ sourceIp: z.string().min(1) }).optional(),
      identity: z.object({ sourceIp: z.string().min(1) }).optional(),
    }),
  }),
});

function nodeAddressOf(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // 接続情報を持たない実行環境（テスト、Lambda など）
    return undefined;
  }
}

function lambdaAddressOf(c: Context<AppEnv>): string | undefined {
  const parsed = LambdaEnvSchema.safeParse(c.env);
  if (!parsed.success) {
    return undefined;
  }
  const { http, identity } = parsed.data.event.requestContext;
  return http?.sourceIp ?? identity?.sourceIp;
}

/** X-Forwarded-For の末尾から数えて、trustedProxyHops 番目の値。値の数が足りなければ undefined。 */
function forwardedAddressOf(c: Context<AppEnv>, trustedProxyHops: number): string | undefined {
  if (trustedProxyHops <= 0) {
    return undefined;
  }
  const entries = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length >= trustedProxyHops
    ? entries[entries.length - trustedProxyHops]
    : undefined;
}

export function clientAddressOf(c: Context<AppEnv>, trustedProxyHops: number): string | undefined {
  return forwardedAddressOf(c, trustedProxyHops) ?? nodeAddressOf(c) ?? lambdaAddressOf(c);
}

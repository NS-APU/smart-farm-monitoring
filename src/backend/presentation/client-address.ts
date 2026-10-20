/**
 * 接続元の識別（ログインの試行回数の制限に使う）。
 * - `X-Forwarded-For` は、クライアントが自由に付けられるため、既定では信頼しない。
 *   信頼するプロキシの段数（`TRUSTED_PROXY_HOPS`）を指定した場合だけ、末尾から数えた値（信頼するプロキシが付けた値）を使う
 *   （先頭の値は、クライアントの申告のため使わない。V-007）。
 * - 関数の URL は、`X-Forwarded-For` を最初の 1 つ（クライアントが付けられる値）に切り詰めるため、CloudFront を経由する構成では、
 *   段数で識別できない。代わりに、CloudFront の Function が利用者の IP を入れるヘッダー（`CLIENT_IP_HEADER`）を使う（Issue #100）。
 *   値は、IP として正しいときだけ使う（CloudFront を経由しない呼び出しでは、クライアントが値を付けられる）。
 * - 接続元は、実行形態ごとに取り方が異なる: Node サーバーは、接続情報（conninfo）、Lambda は、イベントの `sourceIp`。
 *   取得できない場合は undefined（呼び出し側が、ユーザーID単位に切り替える。V-008）。
 */

import { isIP } from 'node:net';
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

/** 指定したヘッダーの値。IP として正しくなければ undefined。 */
function headerAddressOf(c: Context<AppEnv>, headerName: string | undefined): string | undefined {
  if (headerName === undefined) {
    return undefined;
  }
  const value = c.req.header(headerName)?.trim();
  return value !== undefined && isIP(value) !== 0 ? value : undefined;
}

export function clientAddressOf(
  c: Context<AppEnv>,
  trustedProxyHops: number,
  clientIpHeader?: string,
): string | undefined {
  return (
    headerAddressOf(c, clientIpHeader) ??
    forwardedAddressOf(c, trustedProxyHops) ??
    nodeAddressOf(c) ??
    lambdaAddressOf(c)
  );
}

/** JSON の応答と ETag（条件付き取得）。 */

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { AppEnv } from './api-deps.ts';

/** If-None-Match の値（複数・弱い比較の W/・ワイルドカード）が、ETag に一致するか。 */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) {
    return false;
  }
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
}

/**
 * JSON を返す。ただし、前回の応答と同じ内容（If-None-Match が ETag に一致）なら、本文のない 304 を返す
 * （約10秒間隔の読み直しで、変化がなければ小さな応答にする。functional-specification.md 3.1）。
 * 認証・認可は、この関数を呼ぶ前に済んでいる（304 で認証を回避できない）。
 */
export function jsonWithEtag(c: Context<AppEnv>, body: unknown): Response {
  const text = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  c.header('etag', etag);
  if (matchesEtag(c.req.header('if-none-match'), etag)) {
    return c.body(null, 304);
  }
  return c.body(text, 200, { 'content-type': 'application/json; charset=UTF-8' });
}

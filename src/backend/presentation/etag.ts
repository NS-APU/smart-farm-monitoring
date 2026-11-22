/** JSON の応答と ETag（条件付き取得）。 */

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { AppError } from '@smart-farm/shared/errors';
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

/** 内容（JSON）の版。本文のハッシュで、内容が変わると変わる。 */
function etagOf(text: string): string {
  return `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
}

/** 他の管理者が先に変更したとき（If-Match が現在の版と一致しない）のメッセージ。画面にも、そのまま示す。 */
const STALE_VERSION_MESSAGE = '他の管理者が変更しました。読み込み直してください';
const IF_MATCH_REQUIRED_MESSAGE =
  '更新するには、読み込んだ時点の版（If-Match ヘッダー）の指定が必要です';

/**
 * 更新の条件（版つき更新）: If-Match が、現在の内容の版（ETag）と一致しなければ、更新しない。
 * - If-Match がない: 428（PRECONDITION_REQUIRED）。版を確かめない更新は、受け付けない
 * - 一致しない（ほかの変更で、版が変わっている）: 409（CONFLICT）
 * 一致の判定は、カンマ区切りの複数の値のいずれか。弱い比較の接頭辞（W/。配信の途中で付くことがある）は除く。
 * ワイルドカード（*）は、条件として受け付けない。
 * 認証・認可・対象の存在の確認のあと、更新の前に呼ぶ。
 */
export function assertIfMatch(c: Context<AppEnv>, current: unknown): void {
  const ifMatch = c.req.header('if-match');
  if (ifMatch === undefined || ifMatch.trim() === '') {
    throw new AppError('PRECONDITION_REQUIRED', IF_MATCH_REQUIRED_MESSAGE);
  }
  const etag = etagOf(JSON.stringify(current));
  const matched = ifMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .includes(etag);
  if (!matched) {
    throw new AppError('CONFLICT', STALE_VERSION_MESSAGE);
  }
}

/**
 * JSON を返す。ただし、前回の応答と同じ内容（If-None-Match が ETag に一致）なら、本文のない 304 を返す
 * （約10秒間隔の読み直しで、変化がなければ小さな応答にする。functional-specification.md 3.1）。
 * 認証・認可は、この関数を呼ぶ前に済んでいる（304 で認証を回避できない）。
 */
export function jsonWithEtag(c: Context<AppEnv>, body: unknown): Response {
  const text = JSON.stringify(body);
  const etag = etagOf(text);
  c.header('etag', etag);
  if (matchesEtag(c.req.header('if-none-match'), etag)) {
    return c.body(null, 304);
  }
  return c.body(text, 200, { 'content-type': 'application/json; charset=UTF-8' });
}

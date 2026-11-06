/**
 * HTTP のファイルのメタデータ・取得（Issue #119。ADR-0023）。設備ごとのファイルのパスに、リクエストを送る。
 * 内部のアドレスの拒否・リダイレクトに従わない・理由だけを出す、は、http-client.ts のとおり。
 */

import type { HttpFileStat } from '../../application/ingestion/routing-file-source.ts';
import { FileSourceFailure } from '../../application/ports/file-source-port.ts';
import { reasonOfStatus, sendHttpRequest, type HttpTarget } from './http-client.ts';
import { isHeadUnsupported } from './http-probe.ts';

function parseModifiedAt(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
}

function parseSize(value: string | undefined, pattern: RegExp): number | undefined {
  const text = value === undefined ? undefined : pattern.exec(value)?.[1];
  return text === undefined ? undefined : Number(text);
}

/**
 * ファイルのメタデータ（大きさ・更新日時）を得る。HEAD を使う（本文は、取得しない）。HEAD を使えないサーバーは、先頭 1 バイトだけの GET。
 * 失敗は、FileSourceFailure（reason つき）。
 */
export async function statHttpFile(target: HttpTarget): Promise<HttpFileStat> {
  let response = await sendHttpRequest(target, { method: 'HEAD' });
  let usedRange = false;
  if (isHeadUnsupported(response.status)) {
    usedRange = true;
    response = await sendHttpRequest(target, {
      method: 'GET',
      extraHeaders: { Range: 'bytes=0-0' },
    });
  }
  const reason = reasonOfStatus(response.status);
  if (reason !== undefined) {
    throw new FileSourceFailure(reason);
  }
  const modifiedAt = parseModifiedAt(response.headers['last-modified']);
  let sizeBytes: number | undefined;
  if (response.status === 416) {
    // 空のファイルへの Range は、416 になる
    sizeBytes = 0;
  } else if (usedRange) {
    sizeBytes = parseSize(response.headers['content-range'], /\/(\d+)$/);
  } else {
    sizeBytes = parseSize(response.headers['content-length'], /^(\d+)$/);
  }
  return {
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  };
}

/** ファイルの内容（UTF-8 のテキスト）を、GET で取得する。`maxBytes` を超える本文は、TOO_LARGE で失敗する（読み切らない）。 */
export async function readHttpFile(
  target: HttpTarget & { readonly maxBytes: number },
): Promise<string> {
  const response = await sendHttpRequest(target, { method: 'GET', maxBytes: target.maxBytes });
  const reason = reasonOfStatus(response.status);
  if (reason !== undefined) {
    throw new FileSourceFailure(reason);
  }
  return response.body;
}

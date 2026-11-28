/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の中核。ロボットが置いた（`PUT`）設備ごとのファイルを、取り込み（JB-01）の HTTP アダプタが
 * 読む（`GET`・`HEAD`。ADR-0023）。HTTP の入り口（Lambda の Function URL）に依存しない、リクエスト・レスポンスの変換だけを持つ。
 *
 * - 認証: `Authorization: Bearer <トークン>`。**読み取り用**（`GET`・`HEAD`）と**書き込み用**（`PUT`）の 2 種類を分け、互いの権限には使えない。
 *   トークンは、SecretPort（パラメータストア）から読む。値は、カンマで区切って 2 つまで並べられる（ローテーション中の新旧の併存）。
 *   未設定のあいだは、すべて拒否する。照合は、定数時間で行う（先頭の一致で、早く終わらない）
 * - `PUT`: パスは `FilePathSchema`（設備の `sourceFilePath` と同じ規則）。大きさは 1 MiB まで。JSON（UTF-8）として読める内容だけ置く。
 *   不正なら置かず、すでにあるファイルを残す。形式の詳細（項目・型）の検査は、取り込み側の役割（ここでは、しない）
 * - 認証の失敗は、置く検査より先に返す（認証されない相手に、検査の結果を知らせない）。メソッドの判定は、認証より先
 * - ログに、トークン・本文・ファイルパスを出さない。AWS のエラーの内容も出さない（エラーの種類の名前だけ）
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { FilePathSchema } from '@smart-farm/shared/schemas/file-path';
import type { HostedFileMetadata, HostedFileStorePort } from '../ports/hosted-file-store-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { SecretPort } from '../ports/secret-port.ts';

/** 読み取り用のトークンの、秘密情報の参照名（`GET`・`HEAD`）。 */
export const HOSTED_FILE_READ_TOKEN_REFERENCE = 'hosted-file-server/read-token';
/** 書き込み用のトークンの、秘密情報の参照名（`PUT`）。 */
export const HOSTED_FILE_WRITE_TOKEN_REFERENCE = 'hosted-file-server/write-token';
/** 置けるファイルの大きさの上限（バイト。1 MiB）。データ定義の「通常 1 MB 以内」。取り込み側の読む上限（10 MiB）より、小さい。 */
export const HOSTED_FILE_MAX_BYTES = 1024 * 1024;
/** 1 つの秘密情報に並べられるトークンの数の上限（ローテーションの新旧）。 */
const MAX_TOKENS = 2;

export interface HostedFileRequest {
  readonly method: string;
  /** リクエストのパス（クエリを除く。`/` で始まる）。 */
  readonly path: string;
  /** `Authorization` ヘッダーの値。 */
  readonly authorization?: string | undefined;
  /** リクエストの本文（バイト列）。 */
  readonly body?: Buffer | undefined;
}

export interface HostedFileResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HostedFileServerDeps {
  readonly store: HostedFileStorePort;
  readonly secrets: SecretPort;
  readonly logger: Logger;
}

export type HostedFileServer = (request: HostedFileRequest) => Promise<HostedFileResponse>;

const ALLOWED_METHODS = 'GET, HEAD, PUT';

function textResponse(
  statusCode: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): HostedFileResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body,
  };
}

/** ファイルがあるときのレスポンス（GET・HEAD。ヘッダーは同じ）。 */
function fileResponse(metadata: HostedFileMetadata, body: string): HostedFileResponse {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Last-Modified': metadata.lastModified.toUTCString(),
      ...(metadata.etag === undefined ? {} : { ETag: metadata.etag }),
    },
    body,
  };
}

const unauthorized = (): HostedFileResponse =>
  textResponse(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
const unavailable = (): HostedFileResponse => textResponse(503, 'Service Unavailable');

const digestOf = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** 秘密情報の値（カンマ区切り）から、トークンを取り出す（前後の空白は無視。空は除く。2 つまで）。 */
function parseTokens(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, MAX_TOKENS);
}

/** `Authorization: Bearer <トークン>` から、トークンを取り出す（スキームは、大文字・小文字を区別しない）。 */
function bearerTokenOf(authorization: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? '');
  return match?.[1];
}

/** 提示されたトークンが、有効なトークンのどれかと一致するか。すべてと比べる（定数時間）。 */
function matchesAny(presented: string, valid: readonly string[]): boolean {
  const presentedDigest = digestOf(presented);
  let matched = false;
  for (const token of valid) {
    if (timingSafeEqual(presentedDigest, digestOf(token))) {
      matched = true;
    }
  }
  return matched;
}

/** 本文が、UTF-8 の JSON として読めるか。 */
function isUtf8Json(body: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    JSON.parse(text);
    return text;
  } catch {
    return undefined;
  }
}

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

export function createHostedFileServer(deps: HostedFileServerDeps): HostedFileServer {
  const { store, secrets, logger } = deps;

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') {
      return textResponse(405, 'Method Not Allowed', { Allow: ALLOWED_METHODS });
    }
    const writes = method === 'PUT';

    let validTokens: string[];
    try {
      validTokens = parseTokens(
        await secrets.get(
          writes ? HOSTED_FILE_WRITE_TOKEN_REFERENCE : HOSTED_FILE_READ_TOKEN_REFERENCE,
        ),
      );
    } catch (error) {
      logger.error('ファイルサーバーのトークンを読み出せません', { errorName: errorNameOf(error) });
      return unavailable();
    }
    const presented = bearerTokenOf(request.authorization);
    if (presented === undefined || !matchesAny(presented, validTokens)) {
      logger.warn('ファイルサーバーの認証に失敗しました', { method });
      return unauthorized();
    }

    const parsedPath = FilePathSchema.safeParse(request.path);
    if (!parsedPath.success) {
      return writes
        ? textResponse(400, 'Bad Request: invalid path')
        : textResponse(404, 'Not Found');
    }
    const path = parsedPath.data;

    try {
      if (writes) {
        return await putFile(path, request.body);
      }
      if (method === 'HEAD') {
        // HEAD は、メタデータだけを得る（本文を読まない）
        const metadata = await store.head(path);
        return metadata === undefined ? textResponse(404, 'Not Found') : fileResponse(metadata, '');
      }
      const file = await store.get(path);
      return file === undefined ? textResponse(404, 'Not Found') : fileResponse(file, file.body);
    } catch (error) {
      logger.error('ファイルサーバーの保管先の操作に失敗しました', {
        method,
        errorName: errorNameOf(error),
      });
      return unavailable();
    }
  };

  async function putFile(path: string, body: Buffer | undefined): Promise<HostedFileResponse> {
    if (body === undefined || body.length === 0) {
      return textResponse(400, 'Bad Request: the body is empty');
    }
    if (body.length > HOSTED_FILE_MAX_BYTES) {
      return textResponse(413, 'Payload Too Large');
    }
    const text = isUtf8Json(body);
    if (text === undefined) {
      return textResponse(400, 'Bad Request: the body must be JSON (UTF-8)');
    }
    await store.put(path, text);
    logger.info('ファイルを置きました', { bytes: body.length });
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }
}

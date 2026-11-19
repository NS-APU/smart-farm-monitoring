/**
 * ファイルサーバーの認証情報（Issue #172。ADR-0022）。
 * 値（パスワード・トークン・API キー）は、SecretPort の `file-server/<取り込み元の識別子>` に置く（NFR-5.4）。
 * 値の形式は、認証方式ごとに、次のとおり。
 * - BASIC: JSON `{"username":"…","password":"…"}`
 * - BEARER: トークンの文字列
 * - API_KEY: API キーの文字列（送るヘッダー名は、接続設定の apiKeyHeaderName）
 * 値は、エラー・ログに含めない（失敗は、理由だけを持つ FileSourceFailure）。
 */

import { createHash } from 'node:crypto';
import type {
  HttpFileServerConnection,
  IngestionCredentialsInput,
} from '@smart-farm/shared/schemas/ingestion';
import { FileSourceFailure } from '../ports/file-source-port.ts';
import { parseSecretReference } from '../secret-reference.ts';

/** 取り込み元の認証情報の、秘密情報の参照名。 */
export function fileServerSecretReference(sourceId: string): string {
  return parseSecretReference(`file-server/${sourceId}`);
}

/**
 * 設備ごとの認証情報の、秘密情報の参照名（Issue #367。ADR-0026）: `file-server/equipment/<設備 ID の SHA-256 の先頭 32 文字（16 進）>`。
 * 設備 ID は、大文字・100 文字まで使えるが、参照名は、小文字・1 階層 64 文字までのため、ハッシュにする（同じ設備 ID は、常に同じ参照名）。
 */
export function fileServerEquipmentSecretReference(equipmentId: string): string {
  const digest = createHash('sha256').update(equipmentId, 'utf8').digest('hex').slice(0, 32);
  return parseSecretReference(`file-server/equipment/${digest}`);
}

/** ヘッダーの値にできる文字（表示できる ASCII。改行・制御文字・日本語を含めない）。 */
const HEADER_VALUE = /^[\x21-\x7e]+$/;

function tokenValue(value: string | undefined): string {
  const token = value?.trim();
  if (token === undefined || token === '') {
    throw new FileSourceFailure('CREDENTIALS_MISSING');
  }
  if (!HEADER_VALUE.test(token)) {
    throw new FileSourceFailure('CREDENTIALS_INVALID');
  }
  return token;
}

function basicCredentials(value: string | undefined): { username: string; password: string } {
  if (value === undefined || value.trim() === '') {
    throw new FileSourceFailure('CREDENTIALS_MISSING');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new FileSourceFailure('CREDENTIALS_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FileSourceFailure('CREDENTIALS_INVALID');
  }
  const { username, password } = parsed as Record<string, unknown>;
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username === '' ||
    password === '' ||
    username.includes(':')
  ) {
    throw new FileSourceFailure('CREDENTIALS_INVALID');
  }
  return { username, password };
}

/** 登録の入力（画面から）を、秘密情報の値にする。形式は、上のとおり（buildAuthHeaders が読む形）。 */
export function credentialsSecretValue(input: IngestionCredentialsInput): string {
  switch (input.authMethod) {
    case 'BASIC':
      return JSON.stringify({ username: input.username, password: input.password });
    case 'BEARER':
      return input.token;
    case 'API_KEY':
      return input.apiKey;
  }
}

/** 認証方式に合わせた、リクエストのヘッダー。認証なし（NONE）は、空。値がない・形式が違うときは、FileSourceFailure。 */
export function buildAuthHeaders(
  connection: HttpFileServerConnection,
  secretValue: string | undefined,
): Record<string, string> {
  switch (connection.authMethod) {
    case 'NONE':
      return {};
    case 'BASIC': {
      const { username, password } = basicCredentials(secretValue);
      return {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      };
    }
    case 'BEARER':
      return { Authorization: `Bearer ${tokenValue(secretValue)}` };
    case 'API_KEY':
      return { [connection.apiKeyHeaderName]: tokenValue(secretValue) };
  }
}

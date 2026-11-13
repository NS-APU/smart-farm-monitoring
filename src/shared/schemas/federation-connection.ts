/**
 * 農業情報基盤の連携先の設定（ADR-0024。Issue #177）。
 * - 接続先（エンドポイントの URL）: 書き込み専用の秘密情報（画面・ログ・エラーに出さない。SecretPort）
 * - テナント名・context の URL・有効／無効: 通常の設定
 * 接続先・認証情報・ホスト名を、リポジトリ・Issue・PR に書かない（リポジトリは公開）。
 */

import { z } from 'zod';

/** テナント名の既定（NGSI-LD の `NGSILD-Tenant`）。 */
export const DEFAULT_FEDERATION_TENANT = 'smart_farm_monitoring';

const MAX_URL_LENGTH = 2048;

export interface FederationEndpoint {
  readonly protocol: 'HTTP' | 'HTTPS';
  readonly host: string;
  readonly port?: number;
  /** 基準のパス（例: `/api/orion/ngsi-ld/v1`）。末尾の `/` は、ない。なければ、空。 */
  readonly basePath: string;
}

/**
 * http・https の URL を、認証情報・クエリ・フラグメント・空白を含まない形で読む。正しくなければ undefined。
 * （共有のコードは、フロントエンドとバックエンドの両方で使うため、`URL` クラスに頼らず、形を直接に検査する。）
 */
const HTTP_URL =
  /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?(\/[^\s?#]*)?$/i;

function parseHttpUrl(value: string):
  | {
      readonly protocol: 'HTTP' | 'HTTPS';
      readonly host: string;
      readonly port?: number;
      readonly path: string;
    }
  | undefined {
  if (value === '' || value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  const match = HTTP_URL.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, scheme = '', host = '', portText, path = ''] = match;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (port < 1 || port > 65_535)) {
    return undefined;
  }
  return {
    protocol: scheme.toLowerCase() === 'https' ? 'HTTPS' : 'HTTP',
    host: host.toLowerCase(),
    ...(port === undefined ? {} : { port }),
    path,
  };
}

/** 接続先の URL を、プロトコル・ホスト・ポート・基準のパスに分ける。正しくなければ undefined。 */
export function parseFederationEndpoint(value: string): FederationEndpoint | undefined {
  const url = parseHttpUrl(value);
  if (url === undefined) {
    return undefined;
  }
  return {
    protocol: url.protocol,
    host: url.host,
    ...(url.port === undefined ? {} : { port: url.port }),
    basePath: url.path.replace(/\/+$/, ''),
  };
}

/** 接続先の URL の入力（書き込み専用）。 */
export const FederationEndpointInputSchema = z
  .string()
  .trim()
  .refine((value) => parseFederationEndpoint(value) !== undefined, {
    message:
      '接続先は、http または https の URL（認証情報・クエリ・# を含まない）で指定してください',
  });

export const FederationTenantSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    'テナント名は、英小文字で始まる、英小文字・数字・_ の 64 文字以内で指定してください',
  );

export const FederationContextUrlSchema = z
  .string()
  .trim()
  .refine((value) => parseHttpUrl(value) !== undefined, {
    message:
      'context の URL は、http または https の URL（認証情報・クエリ・# を含まない）で指定してください',
  });

/** 連携先の通常の設定（接続先を除く）。 */
export const FederationSettingsSchema = z.object({
  tenant: FederationTenantSchema,
  contextUrl: FederationContextUrlSchema,
  enabled: z.boolean(),
});
export type FederationSettings = z.infer<typeof FederationSettingsSchema>;

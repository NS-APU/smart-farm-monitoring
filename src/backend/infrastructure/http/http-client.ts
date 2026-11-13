/**
 * HTTP のファイルサーバーへのリクエスト（Issue #172・#119。ADR-0022・ADR-0023）。接続テスト・一覧（メタデータ）・取得が共通で使う。
 *
 * 管理者が接続先を設定できるため、SSRF の対策として、次を守る。
 * - 内部のアドレス（address-guard.ts）には、接続しない。名前は、接続の直前の名前の解決の結果で検査する（DNS リバインディングの対策）
 * - リダイレクトには、従わない（内部のアドレスへ誘導されないように）
 * - 失敗の理由は、固定の文言にする。接続先・ファイルパス・認証情報を、エラー・ログに出さない（原因の詳細も、残さない）
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  defaultHttpPort,
  type HttpFileServerConnection,
} from '@smart-farm/shared/schemas/ingestion';
import {
  FileSourceFailure,
  type FileSourceFailureReason,
} from '../../application/ports/file-source-port.ts';
import { isBlockedConnectionHost, isBlockedIpAddress } from './address-guard.ts';

/** 応答を待つ時間（ミリ秒）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** 名前の解決（テストでは、差し替える）。`dns.lookup` の、全件を返す形。 */
export type HostResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** リクエストの共通の指定（接続先・認証のヘッダー・接続の制御）。 */
export interface HttpTarget {
  readonly connection: HttpFileServerConnection;
  /** ファイルのパス（設備ごと。ADR-0023）。 */
  readonly path: string;
  /** 認証のヘッダー（値は、秘密情報から組み立てたもの）。 */
  readonly headers: Readonly<Record<string, string>>;
  /** true なら、内部のアドレスにも接続する（ローカル・テスト用。本番・開発サイトでは、指定しない）。 */
  readonly allowPrivateAddresses?: boolean;
  readonly timeoutMs?: number;
  readonly resolver?: HostResolver;
}

export interface HttpResponseInfo {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** `maxBytes` を指定したときだけ、本文（UTF-8）。 */
  readonly body: string;
}

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** ネットワークのエラーを、利用者に見せる理由に分類する。エラーの内容そのものは、使わない。 */
export function classifyNetworkError(error: unknown): FileSourceFailureReason {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (CERTIFICATE_CODES.has(code)) {
    return 'CERTIFICATE';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return 'TIMEOUT';
  }
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
    return 'TLS';
  }
  return 'UNREACHABLE';
}

/** 名前の解決の結果を、すべて検査する。1 つでも内部のアドレスがあれば、拒否する。 */
export function createGuardedLookup(resolver: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(
      hostname,
      { all: true, family: options.family, hints: options.hints },
      (error, addresses) => {
        if (error !== null) {
          callback(error, '', 4);
          return;
        }
        const first = addresses[0];
        if (first === undefined || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
          callback(new FileSourceFailure('ADDRESS_BLOCKED'), '', 4);
          return;
        }
        if (options.all === true) {
          callback(null, addresses);
          return;
        }
        callback(null, first.address, first.family);
      },
    );
  };
}

/** 状態コードを、失敗の理由に分類する。成功（2xx と、空のファイルへの Range の 416）は、undefined。 */
export function reasonOfStatus(status: number): FileSourceFailureReason | undefined {
  if ((status >= 200 && status < 300) || status === 416) {
    return undefined;
  }
  if (status >= 300 && status < 400) {
    return 'REDIRECT';
  }
  if (status === 401 || status === 403) {
    return 'AUTH_FAILED';
  }
  if (status === 404 || status === 410) {
    return 'NOT_FOUND';
  }
  return status >= 500 ? 'SERVER_ERROR' : 'UNEXPECTED_RESPONSE';
}

export interface RequestOptions {
  readonly method: 'HEAD' | 'GET';
  /** リクエストに付ける、追加のヘッダー（Range など）。 */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** 指定すると、成功（2xx）の本文を、この大きさまで読む。超えたら、TOO_LARGE。指定しなければ、本文を読まない。 */
  readonly maxBytes?: number;
}

/** 接続の直前の検査の準備（接続先の検査・名前の解決の検査）。 */
function prepareGuards(target: HttpTarget): {
  readonly hostname: string;
  readonly lookup: LookupFunction | undefined;
} {
  const { connection } = target;
  const allowPrivate = target.allowPrivateAddresses === true;
  const hostname = connection.host.startsWith('[') ? connection.host.slice(1, -1) : connection.host;
  if (!allowPrivate && isBlockedConnectionHost(connection.host)) {
    throw new FileSourceFailure('ADDRESS_BLOCKED');
  }
  // IP アドレスの直接の指定は、名前の解決がないため、上で検査済み。名前は、接続の直前に、解決の結果を検査する
  const lookup =
    allowPrivate || isIP(hostname) !== 0
      ? undefined
      : createGuardedLookup(target.resolver ?? dnsLookup);
  return { hostname, lookup };
}

/**
 * リクエストを 1 回送り、状態コード・ヘッダー（・本文）を返す。状態コードの良し悪しは、判定しない（呼び出し側が、reasonOfStatus で判定する）。
 * 失敗（接続できない・時間切れ・内部のアドレス・本文が大きすぎる）は、FileSourceFailure。
 */
export async function sendHttpRequest(
  target: HttpTarget,
  options: RequestOptions,
): Promise<HttpResponseInfo> {
  const { hostname, lookup } = prepareGuards(target);
  const { connection } = target;
  const timeoutMs = target.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'User-Agent': 'smart-farm-monitoring',
    Accept: '*/*',
    ...target.headers,
    ...options.extraHeaders,
  };

  return new Promise<HttpResponseInfo>((resolve, reject) => {
    const transport = connection.protocol === 'HTTPS' ? https : http;
    let settled = false;
    const finish = (action: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        action();
      }
    };
    const fail = (error: unknown): void => {
      finish(() => {
        reject(
          error instanceof FileSourceFailure
            ? error
            : new FileSourceFailure(classifyNetworkError(error)),
        );
      });
    };
    const request = transport.request(
      {
        method: options.method,
        hostname,
        port: connection.port ?? defaultHttpPort(connection.protocol),
        path: target.path,
        headers,
        agent: false,
        ...(lookup === undefined ? {} : { lookup }),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const readsBody = options.maxBytes !== undefined && status >= 200 && status < 300;
        if (!readsBody) {
          response.destroy();
          finish(() => {
            resolve({ status, headers: response.headers, body: '' });
          });
          return;
        }
        const maxBytes = options.maxBytes ?? 0;
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          request.destroy();
          fail(new FileSourceFailure('TOO_LARGE'));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            request.destroy();
            fail(new FileSourceFailure('TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() => {
            resolve({
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
        // 本文を読み終える前に、接続が切れた（応答が打ち切られた）場合（読み終えたあとの close は、finish が済んでいるため、無視される）
        response.on('error', fail);
        response.on('close', () => {
          fail(new FileSourceFailure('UNREACHABLE'));
        });
      },
    );
    const timer = setTimeout(() => {
      finish(() => {
        reject(new FileSourceFailure('TIMEOUT'));
      });
      request.destroy();
    }, timeoutMs);
    request.on('error', fail);
    request.end();
  });
}

/**
 * HTTP のファイルの接続テスト（Issue #172。ADR-0022）。
 * 取り込み元の接続設定（HTTP）の接続先に、HEAD（使えなければ、先頭 1 バイトの GET）でリクエストを送り、ファイルがあることを確かめる。
 *
 * 管理者が接続先を設定できるため、SSRF の対策として、次を守る。
 * - 内部のアドレス（address-guard.ts）には、接続しない。名前は、接続の直前の名前の解決の結果で検査する（DNS リバインディングの対策）
 * - リダイレクトには、従わない（内部のアドレスへ誘導されないように）
 * - 失敗の理由は、固定の文言にする。接続先・ファイルパス・認証情報を、エラー・ログに出さない（原因の詳細も、残さない）
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import http from 'node:http';
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

/** 接続テストの応答を待つ時間（ミリ秒）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** 名前の解決（テストでは、差し替える）。`dns.lookup` の、全件を返す形。 */
export type HostResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface HttpProbeOptions {
  readonly connection: HttpFileServerConnection;
  /** 認証のヘッダー（値は、秘密情報から組み立てたもの）。 */
  readonly headers: Readonly<Record<string, string>>;
  /** true なら、内部のアドレスにも接続する（ローカル・テスト用。本番・開発サイトでは、指定しない）。 */
  readonly allowPrivateAddresses?: boolean;
  readonly timeoutMs?: number;
  readonly resolver?: HostResolver;
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
function createGuardedLookup(resolver: HostResolver): LookupFunction {
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

function reasonOfStatus(status: number): FileSourceFailureReason | undefined {
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

interface RequestOnceOptions {
  readonly method: 'HEAD' | 'GET';
  readonly headers: Record<string, string>;
  readonly lookup: LookupFunction | undefined;
  readonly timeoutMs: number;
}

/** リクエストを 1 回送り、状態コードを返す（本文は、読まない）。失敗は、FileSourceFailure。 */
function requestOnce(
  connection: HttpFileServerConnection,
  hostname: string,
  options: RequestOnceOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const transport = connection.protocol === 'HTTPS' ? https : http;
    let settled = false;
    const finish = (action: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        action();
      }
    };
    const request = transport.request(
      {
        method: options.method,
        hostname,
        port: connection.port ?? defaultHttpPort(connection.protocol),
        path: connection.filePath,
        headers: options.headers,
        agent: false,
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        finish(() => {
          resolve(status);
        });
      },
    );
    const timer = setTimeout(() => {
      finish(() => {
        reject(new FileSourceFailure('TIMEOUT'));
      });
      request.destroy();
    }, options.timeoutMs);
    request.on('error', (error: unknown) => {
      finish(() => {
        reject(
          error instanceof FileSourceFailure
            ? error
            : new FileSourceFailure(classifyNetworkError(error)),
        );
      });
    });
    request.end();
  });
}

/**
 * 接続先に、ファイルがあることを確かめる。成功は、何も返さない。失敗は、FileSourceFailure（reason つき）を投げる。
 */
export async function probeHttpFile(options: HttpProbeOptions): Promise<void> {
  const { connection } = options;
  const allowPrivate = options.allowPrivateAddresses === true;
  const hostname = connection.host.startsWith('[') ? connection.host.slice(1, -1) : connection.host;
  const isLiteral = isIP(hostname) !== 0;

  if (!allowPrivate && isBlockedConnectionHost(connection.host)) {
    throw new FileSourceFailure('ADDRESS_BLOCKED');
  }
  // IP アドレスの直接の指定は、名前の解決がないため、上で検査済み。名前は、接続の直前に、解決の結果を検査する
  const lookup =
    allowPrivate || isLiteral ? undefined : createGuardedLookup(options.resolver ?? dnsLookup);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const baseHeaders: Record<string, string> = {
    'User-Agent': 'smart-farm-monitoring',
    Accept: '*/*',
    ...options.headers,
  };

  let status = await requestOnce(connection, hostname, {
    method: 'HEAD',
    headers: baseHeaders,
    lookup,
    timeoutMs,
  });
  // HEAD を使えないサーバーは、先頭 1 バイトだけの GET で、ファイルがあることを確かめる
  if (status === 405 || status === 501) {
    status = await requestOnce(connection, hostname, {
      method: 'GET',
      headers: { ...baseHeaders, Range: 'bytes=0-0' },
      lookup,
      timeoutMs,
    });
  }
  const reason = reasonOfStatus(status);
  if (reason !== undefined) {
    throw new FileSourceFailure(reason);
  }
}

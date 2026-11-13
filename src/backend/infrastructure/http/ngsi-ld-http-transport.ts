/**
 * 農業情報基盤への HTTP の送信（NGSI-LD の upsert。ADR-0024。Issue #177）。
 * 管理者が接続先を設定できるため、ファイルサーバーの接続（http-client.ts。ADR-0022）と同じく、SSRF の対策として、次を守る。
 * - 内部のアドレスには、接続しない。名前は、接続の直前の名前の解決の結果で検査する（DNS リバインディングの対策）
 * - リダイレクトには、従わない
 * - 失敗の理由は、固定の文言にする。接続先・本文を、エラー・ログに出さない（原因の詳細も、残さない）
 * 依存は、追加しない（Node の http・https）。
 */

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { FileSourceFailure } from '../../application/ports/file-source-port.ts';
import { isBlockedConnectionHost } from './address-guard.ts';
import { classifyNetworkError, createGuardedLookup, type HostResolver } from './http-client.ts';

export type NgsiLdTransportFailureReason =
  'UNREACHABLE' | 'TIMEOUT' | 'TLS' | 'CERTIFICATE' | 'ADDRESS_BLOCKED' | 'TOO_LARGE';

const FAILURE_MESSAGES: Readonly<Record<NgsiLdTransportFailureReason, string>> = {
  UNREACHABLE: '農業情報基盤に接続できません',
  TIMEOUT: '農業情報基盤から応答がありません',
  TLS: '農業情報基盤との暗号化通信に失敗しました',
  CERTIFICATE: '農業情報基盤の証明書を確認できません',
  ADDRESS_BLOCKED: '農業情報基盤の接続先に、内部のアドレスは指定できません',
  TOO_LARGE: '農業情報基盤の応答が大きすぎます',
};

/** 送信の失敗（接続できない・時間切れなど）。メッセージは、固定の文言（接続先・本文を含めない）。 */
export class NgsiLdTransportError extends Error {
  readonly reason: NgsiLdTransportFailureReason;

  constructor(reason: NgsiLdTransportFailureReason) {
    super(FAILURE_MESSAGES[reason]);
    this.name = 'NgsiLdTransportError';
    this.reason = reason;
  }
}

export interface NgsiLdRequest {
  readonly protocol: 'HTTP' | 'HTTPS';
  readonly host: string;
  readonly port?: number;
  /** パスとクエリ（例: `/api/orion/ngsi-ld/v1/entityOperations/upsert?options=update`）。 */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs?: number;
}

export interface NgsiLdResponse {
  readonly status: number;
  /** 応答の本文（UTF-8）。 */
  readonly body: string;
}

/** POST を 1 回送り、状態コードと本文を返す。状態コードの良し悪しは、判定しない（呼び出し側が判定する）。 */
export type NgsiLdTransport = (request: NgsiLdRequest) => Promise<NgsiLdResponse>;

/** 応答を待つ時間（ミリ秒）の既定。 */
export const DEFAULT_NGSI_LD_TIMEOUT_MS = 20_000;
/** 読む本文の大きさの上限（バイト）。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

function reasonOf(error: unknown): NgsiLdTransportFailureReason {
  if (error instanceof FileSourceFailure && error.reason === 'ADDRESS_BLOCKED') {
    return 'ADDRESS_BLOCKED';
  }
  const reason = classifyNetworkError(error);
  return reason === 'TIMEOUT' || reason === 'TLS' || reason === 'CERTIFICATE'
    ? reason
    : 'UNREACHABLE';
}

export function createHttpNgsiLdTransport(
  options: {
    /** true なら、内部のアドレスにも接続する（ローカル・テスト用。本番・開発サイトでは、指定しない）。 */
    readonly allowPrivateAddresses?: boolean;
    readonly resolver?: HostResolver;
  } = {},
): NgsiLdTransport {
  const allowPrivate = options.allowPrivateAddresses === true;

  return (request) => {
    const hostname = request.host.startsWith('[') ? request.host.slice(1, -1) : request.host;
    if (!allowPrivate && isBlockedConnectionHost(request.host)) {
      return Promise.reject(new NgsiLdTransportError('ADDRESS_BLOCKED'));
    }
    // IP アドレスの直接の指定は、名前の解決がないため、上で検査済み。名前は、接続の直前に、解決の結果を検査する
    const lookup =
      allowPrivate || isIP(hostname) !== 0
        ? undefined
        : createGuardedLookup(options.resolver ?? dnsLookup);
    const timeoutMs = request.timeoutMs ?? DEFAULT_NGSI_LD_TIMEOUT_MS;
    const payload = Buffer.from(request.body, 'utf8');

    return new Promise<NgsiLdResponse>((resolve, reject) => {
      const transport = request.protocol === 'HTTPS' ? https : http;
      let settled = false;
      const finish = (action: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          action();
        }
      };
      const fail = (reason: NgsiLdTransportFailureReason): void => {
        finish(() => {
          reject(new NgsiLdTransportError(reason));
        });
      };
      const outgoing = transport.request(
        {
          method: 'POST',
          hostname,
          port: request.port ?? (request.protocol === 'HTTPS' ? 443 : 80),
          path: request.path,
          headers: {
            'User-Agent': 'smart-farm-monitoring',
            Accept: 'application/json',
            ...request.headers,
            'Content-Length': String(payload.length),
          },
          agent: false,
          ...(lookup === undefined ? {} : { lookup }),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              response.destroy();
              outgoing.destroy();
              fail('TOO_LARGE');
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            finish(() => {
              resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
            });
          });
          // 本文を読み終える前に、接続が切れた場合（読み終えたあとの close は、finish が済んでいるため、無視される）
          response.on('error', () => {
            fail('UNREACHABLE');
          });
          response.on('close', () => {
            fail('UNREACHABLE');
          });
        },
      );
      const timer = setTimeout(() => {
        fail('TIMEOUT');
        outgoing.destroy();
      }, timeoutMs);
      outgoing.on('error', (error) => {
        fail(reasonOf(error));
      });
      outgoing.end(payload);
    });
  };
}

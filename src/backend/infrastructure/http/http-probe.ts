/**
 * HTTP のファイルの接続テスト（Issue #172。ADR-0022）。
 * 接続先の、設備のファイルのパスに、HEAD（使えなければ、先頭 1 バイトの GET）でリクエストを送り、ファイルがあることを確かめる。
 * 内部のアドレスの拒否・リダイレクトに従わない・理由だけを出す、は、http-client.ts のとおり。
 */

import { FileSourceFailure } from '../../application/ports/file-source-port.ts';
import { reasonOfStatus, sendHttpRequest, type HttpTarget } from './http-client.ts';

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  classifyNetworkError,
  type HostResolver,
} from './http-client.ts';

export type HttpProbeOptions = HttpTarget;

/** HEAD を使えないサーバー（405・501）か。 */
export function isHeadUnsupported(status: number): boolean {
  return status === 405 || status === 501;
}

/**
 * 接続先に、ファイルがあることを確かめる。成功は、何も返さない。失敗は、FileSourceFailure（reason つき）を投げる。
 */
export async function probeHttpFile(options: HttpProbeOptions): Promise<void> {
  let response = await sendHttpRequest(options, { method: 'HEAD' });
  // HEAD を使えないサーバーは、先頭 1 バイトだけの GET で、ファイルがあることを確かめる
  if (isHeadUnsupported(response.status)) {
    response = await sendHttpRequest(options, {
      method: 'GET',
      extraHeaders: { Range: 'bytes=0-0' },
    });
  }
  const reason = reasonOfStatus(response.status);
  if (reason !== undefined) {
    throw new FileSourceFailure(reason);
  }
}

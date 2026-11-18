/**
 * テスト用の HTTP ファイルサーバー（Issue #344。ADR-0025）。取り込み（JB-01）の HTTP アダプタ（設備ごとの `sourceFilePath` へ `HEAD`・`GET`。
 * ADR-0023）が接続する先を、テストのプロセスの中（127.0.0.1。空きポート）に立てる。モックのファイルサーバー（ディレクトリ・S3）の置き換え。
 * - ファイル: パス → 内容・更新日時（`Last-Modified`。秒の精度）。ファイルがなければ 404
 * - 停止（DOWN）: 接続を切る（応答しない）。遅延（SLOW）: 指定のミリ秒、応答を遅らせる。拒否（REJECT）: 503。復旧（UP）: 通常
 *   （モックの `faults.fileServer` と同じ状態・同じ指定。`faults.set({ mode: 'DOWN' })`）
 * - リクエストの記録（`requests`）: 接続のテスト・取得の回数・順序の確認用
 * 置くのは、合成データだけ（実データ・個人情報は置かない）。サーバーは `unref` して、テストの終了を妨げない。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createFaultController,
  type FaultController,
} from '../../src/backend/infrastructure/local/faults.ts';

export interface HttpFileOptions {
  /** 更新日時（`Last-Modified`）。省略は、置いた時刻（現在）。 */
  readonly modifiedAt?: Date | undefined;
  /** `Last-Modified` を返さない（更新日時を示さないサーバー）。 */
  readonly omitLastModified?: boolean | undefined;
}

export interface HttpFileRequest {
  readonly method: string;
  readonly path: string;
}

export interface HttpFileServer {
  readonly port: number;
  /** 停止・遅延・拒否の再現（モックの faults.fileServer と同じ）。 */
  readonly faults: FaultController;
  /** 受け取ったリクエスト（停止中のものも含む）。 */
  readonly requests: readonly HttpFileRequest[];
  put(path: string, content: string, options?: HttpFileOptions): void;
  remove(path: string): void;
  /** すべてのファイルとリクエストの記録を消し、状態を通常（UP）に戻す。 */
  reset(): void;
  close(): Promise<void>;
}

interface StoredFile {
  readonly body: Buffer;
  readonly modifiedAt: Date;
  readonly omitLastModified: boolean;
}

export async function startHttpFileServer(): Promise<HttpFileServer> {
  const files = new Map<string, StoredFile>();
  const requests: HttpFileRequest[] = [];
  const faults = createFaultController();

  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const method = request.method ?? '';
    requests.push({ method, path });
    const respond = (): void => {
      const { mode } = faults.get();
      if (mode === 'REJECT') {
        response.writeHead(503);
        response.end();
        return;
      }
      const file = files.get(path);
      if (file === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Length': String(file.body.length),
        ...(file.omitLastModified ? {} : { 'Last-Modified': file.modifiedAt.toUTCString() }),
      });
      response.end(method === 'HEAD' ? undefined : file.body);
    };
    const { mode, delayMs } = faults.get();
    if (mode === 'DOWN') {
      // リクエストを読んだあとに、接続を切る（応答しない。リクエストは、記録される。使い回された接続〔keep-alive〕にも効く）
      request.socket.destroy();
      return;
    }
    if (mode === 'SLOW') {
      setTimeout(respond, delayMs);
      return;
    }
    respond();
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  // テストの終了（プロセスの終了）を、妨げない
  server.unref();

  return {
    port,
    faults,
    requests,
    put(path, content, options = {}) {
      files.set(path, {
        body: Buffer.from(content, 'utf8'),
        modifiedAt: options.modifiedAt ?? new Date(),
        omitLastModified: options.omitLastModified ?? false,
      });
    },
    remove(path) {
      files.delete(path);
    },
    reset() {
      files.clear();
      requests.length = 0;
      faults.reset();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

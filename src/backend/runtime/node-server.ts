/**
 * Node サーバーでの実行（ローカル開発・E2E・負荷テスト）。
 * 本番は、同じ Hono アプリを Lambda のハンドラとして使う（lambda.ts）。
 */

import { serve } from '@hono/node-server';
import { MS_PER_SECOND } from '@smart-farm/shared/time';
import type { AddressInfo } from 'node:net';
import { createApp } from '../presentation/create-app.ts';
import type { AppConfig } from './config.ts';
import { createContainer, type Container, type ContainerOverrides } from './container.ts';

export interface RunningServer {
  readonly port: number;
  readonly container: Container;
  /** サーバーを止め、未保存のデータを書き出す。 */
  close(): Promise<void>;
}

export async function startNodeServer(
  config: AppConfig,
  overrides: ContainerOverrides = {},
): Promise<RunningServer> {
  const container = createContainer(config, overrides);
  await container.initialize();
  const app = createApp(container);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  if (config.schedulerEnabled) {
    container.scheduler.start(config.schedulerTickSeconds * MS_PER_SECOND);
  }
  // listening の後の TCP サーバーのアドレスは、AddressInfo（string・null は、UNIX ソケット・未待受のとき）
  const address = server.address() as AddressInfo;
  container.logger.info('サーバーを起動しました', {
    host: config.host,
    port: address.port,
    mode: config.mode,
  });

  return {
    port: address.port,
    container,
    close: () =>
      new Promise<void>((resolve, reject) => {
        container.close();
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        // 待機中の接続（keep-alive）を閉じ、停止を待たせない
        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }
      }),
  };
}

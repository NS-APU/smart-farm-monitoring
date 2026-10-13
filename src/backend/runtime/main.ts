/**
 * ローカルのサーバーの起動エントリ（`pnpm dev:backend`）。環境変数を読み、サーバーを起動する。
 * 起動処理のみで、ロジックを持たない（テストの対象は node-server.ts・shutdown.ts）。
 */

import { parseConfig } from './config.ts';
import { startNodeServer } from './node-server.ts';
import { registerProcessHandlers } from './shutdown.ts';

const server = await startNodeServer(parseConfig(process.env));
registerProcessHandlers(process, server, server.container.logger);

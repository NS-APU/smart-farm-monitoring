/**
 * 負荷テストのバックエンドの起動エントリ。通常のサーバー（runtime/main.ts）と同じ組み立てで起動し、
 * 起動の直後に、大量の合成データ（seed-data.ts）を投入する。投入が終わったら、標準出力に `STRESS_SEED_DONE` を出す
 * （Playwright の webServer は、この出力を待ってから、テストを始める。playwright.stress.config.ts）。
 * 投入した件数は、test-result/stress/dataset.json に書き出す（結果ログの「データ規模」）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { parseConfig } from '../../../src/backend/runtime/config.ts';
import { startNodeServer } from '../../../src/backend/runtime/node-server.ts';
import { registerProcessHandlers } from '../../../src/backend/runtime/shutdown.ts';
import { seedStressData } from './seed-data.ts';

const server = await startNodeServer(parseConfig(process.env));
registerProcessHandlers(process, server, server.container.logger);

const summary = await seedStressData(server.container);
// 起動後の最初の一覧の参照が、計測日時の順の索引の構築で遅くならないよう、先に1回参照する（通常の起動では、データの読み込みの直後に索引を作る）
await server.container.observationQuery.list({ sort: 'observedAt', direction: 'desc', limit: 1 });
mkdirSync('test-result/stress', { recursive: true });
writeFileSync('test-result/stress/dataset.json', JSON.stringify(summary, null, 2), 'utf8');
process.stdout.write(
  `STRESS_SEED_DONE observations=${String(summary.observationsTotal)} seconds=${summary.seedSeconds.toFixed(1)}\n`,
);

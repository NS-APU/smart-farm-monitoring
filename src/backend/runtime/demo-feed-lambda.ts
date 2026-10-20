/**
 * 合成データを定期的に生成する Lambda のハンドラ（擬似のロボット・環境センサー。Issue #77。ADR-0012）。EventBridge が 15 分ごとに起動し、
 * ファイルサーバーのモックの S3（`<バケット>/robot/`・`<バケット>/environment-sensor/`）に、新しい合成データのファイルを置く。
 * 取り込み（JB-01）が、それを読む。要件のジョブ（JB-01〜JB-04）ではなく、**評価環境のデモのための仕掛け**で、
 * DynamoDB・Cognito は使わない（S3 への書き込みだけ）。ジョブの Lambda（job-lambda.ts）とは、別の関数・別の権限にする。
 *
 * 1 回の実行で、直近の数区間のファイルを置く。同じ区間は、同じ名前・同じ内容（上書きしても、取り込みは、内容のハッシュで読み飛ばす）。
 * 失敗したら、例外を投げる（再試行はしない。次の周期で、再び置く）。実データは、使わない（合成データのみ）。
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { errorLogFields } from '../application/error-fields.ts';
import {
  DEMO_FEED_BUCKETS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../application/demo/demo-feed-schedule.ts';
import type { ClockPort } from '../application/ports/clock-port.ts';
import type { Logger } from '../application/ports/logger-port.ts';
import { createSystemClock } from '../infrastructure/local/clocks.ts';
import { buildDemoFeedFiles } from '../infrastructure/local/demo-feed-files.ts';
import { createJsonLogger, STDOUT_SINK } from '../infrastructure/logging/json-logger.ts';
import { ConfigError } from './config.ts';

/** テストで、差し替えるための依存。 */
export interface DemoFeedDeps {
  readonly client?: Pick<S3Client, 'send'>;
  readonly clock?: ClockPort;
  readonly logger?: Logger;
}

export interface DemoFeedResponse {
  /** 置いたファイルの数。 */
  readonly files: number;
}

export type DemoFeedHandler = () => Promise<DemoFeedResponse>;

export function createDemoFeedHandler(
  env: Readonly<Record<string, string | undefined>>,
  deps: DemoFeedDeps = {},
): DemoFeedHandler {
  const client = deps.client ?? new S3Client({});
  const clock = deps.clock ?? createSystemClock();
  const logger = deps.logger ?? createJsonLogger({ sink: STDOUT_SINK, minimumLevel: 'info' });

  return async () => {
    const bucket = env.FILE_SERVER_S3_BUCKET;
    if (bucket === undefined || bucket === '') {
      throw new ConfigError('FILE_SERVER_S3_BUCKET の指定が必要です');
    }
    const files = buildDemoFeedFiles(clock.now(), {
      intervalMinutes: DEMO_FEED_INTERVAL_MINUTES,
      buckets: DEMO_FEED_BUCKETS,
    });
    try {
      for (const file of files) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${file.sourceId}/${file.name}`,
            Body: file.content,
            ContentType: file.contentType,
          }),
        );
      }
    } catch (error) {
      logger.error('合成データのファイルを置けませんでした', { ...errorLogFields(error) });
      throw error;
    }
    logger.info('合成データのファイルを置きました', { files: files.length });
    return { files: files.length };
  };
}

export const handler: DemoFeedHandler = createDemoFeedHandler(process.env);

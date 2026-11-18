/**
 * デモ用の HTTP ファイル配信の Lambda のハンドラ（擬似のロボット・環境センサーのファイル。Issue #344。ADR-0025）。
 * Lambda の Function URL（認証なし。ペイロード形式 2.0）から、`GET`・`HEAD` で、合成データのファイル（取り込み元ごとに 1 つの
 * `latest.json`）を返す。**リクエストごとに**、現在の時刻から、ファイルの内容を作る（保管しない。S3・EventBridge・書き込みの権限は、要らない）。
 * 取り込み（JB-01）の HTTP アダプタ（設備の `sourceFilePath` ごとに `HEAD`・`GET`。ADR-0023）が、実際のファイルサーバーと同じ手順で、読む。
 *
 * - 内容は、`buildDemoFeedFiles`（区間の時刻から決まる。同じ区間は同じ内容）。`Last-Modified` は、現在の区間の開始（その区間に、内容が最後に変わった時刻）
 * - 返すのは、**合成データだけ**（実データ・個人情報・秘密情報は、持たない）。認証は、しない（ADR-0025）
 * - `GET`・`HEAD` 以外は 405、定めたパス以外は 404。クエリ・パスの正規化はしない（完全一致だけ）
 * DynamoDB・Cognito・S3 は使わない。ジョブの Lambda（job-lambda.ts）・S3 へ置く Lambda（demo-feed-lambda.ts）とは、別の関数・別の権限にする。
 */

import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import {
  DEMO_FEED_BUCKETS,
  DEMO_FEED_FILE_PATHS,
  DEMO_FEED_INTERVAL_MINUTES,
} from '../application/demo/demo-feed-schedule.ts';
import type { ClockPort } from '../application/ports/clock-port.ts';
import { createSystemClock } from '../infrastructure/local/clocks.ts';
import { buildDemoFeedFiles } from '../infrastructure/local/demo-feed-files.ts';

/** Function URL のリクエスト（ペイロード形式 2.0 のうち、使う項目だけ）。 */
export interface DemoFeedHttpEvent {
  readonly rawPath?: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
}

/** Function URL のレスポンス。 */
export interface DemoFeedHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** テストで、差し替えるための依存。 */
export interface DemoFeedHttpDeps {
  readonly clock?: ClockPort;
}

export type DemoFeedHttpHandler = (event: DemoFeedHttpEvent) => Promise<DemoFeedHttpResponse>;

const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

function textResponse(
  statusCode: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): DemoFeedHttpResponse {
  return { statusCode, headers: { ...TEXT_HEADERS, ...headers }, body };
}

export function createDemoFeedHttpHandler(deps: DemoFeedHttpDeps = {}): DemoFeedHttpHandler {
  const clock = deps.clock ?? createSystemClock();

  return (event) => {
    const method = (event.requestContext?.http?.method ?? '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return Promise.resolve(textResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' }));
    }
    const now = clock.now();
    const file = buildDemoFeedFiles(now, {
      intervalMinutes: DEMO_FEED_INTERVAL_MINUTES,
      buckets: DEMO_FEED_BUCKETS,
    }).find((candidate) => DEMO_FEED_FILE_PATHS[candidate.sourceId] === event.rawPath);
    if (file === undefined) {
      return Promise.resolve(textResponse(404, 'Not Found'));
    }
    const intervalMs = DEMO_FEED_INTERVAL_MINUTES * MS_PER_MINUTE;
    const modifiedAt = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
    return Promise.resolve({
      statusCode: 200,
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': 'no-store',
        'Last-Modified': modifiedAt.toUTCString(),
      },
      // HEAD は、ヘッダーだけ（Function URL が、本文を取り除く。ここでも、返さない）
      body: method === 'HEAD' ? '' : file.content,
    });
  };
}

export const handler: DemoFeedHttpHandler = createDemoFeedHttpHandler();

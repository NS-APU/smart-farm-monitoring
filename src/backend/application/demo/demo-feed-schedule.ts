/**
 * デモ用の合成データ（擬似のロボット・環境センサー）の配信の定数。HTTP 配信の Lambda（runtime/demo-feed-http-lambda.ts）・デモの取り込みを
 * 配信に向ける処理（runtime/demo-feed-connection.ts）・IaC（infra/lib/evaluation-stack.ts）が、同じ値を使う（Issue #344。ADR-0025）。
 * IaC から読み込まれるため、依存を持たない。
 */

/** 生成の間隔（分）。取り込みの既定の取得間隔（DEFAULT_INGESTION_INTERVAL_MINUTES の既定）と同じ。 */
export const DEMO_FEED_INTERVAL_MINUTES = 15;

/** 温度の基準（℃）。デモのデータ（投入）と同じ。環境適応性が「注意」になり、通知の例が得られる。 */
export const DEMO_FEED_TEMPERATURE_BASE_CELSIUS = 26;

/** 合成データの配信が返す、取り込み元の識別子（ロボット・環境センサー）。 */
export const DEMO_FEED_SOURCE_IDS = ['robot', 'environment-sensor'] as const;
export type DemoFeedSourceId = (typeof DEMO_FEED_SOURCE_IDS)[number];

/**
 * デモ用の HTTP 配信（Issue #344。ADR-0025）が返す、取り込み元ごとのファイルのパス。デモの設備の `sourceFilePath` と、
 * 配信のハンドラ（runtime/demo-feed-http-lambda.ts）が、同じ値を使う。
 */
export const DEMO_FEED_FILE_PATHS: Readonly<Record<DemoFeedSourceId, string>> = {
  robot: '/robot/latest.json',
  'environment-sensor': '/environment-sensor/latest.json',
};

/** デモ用の HTTP 配信の Lambda のタイムアウト（秒）。ファイルを作って返すだけのため、短い。 */
export const DEMO_FEED_HTTP_TIMEOUT_SECONDS = 10;

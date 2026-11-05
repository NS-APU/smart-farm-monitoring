/**
 * 合成データの定期生成（擬似のロボット・環境センサー）の定数。Lambda（runtime/demo-feed-lambda.ts）と、IaC
 * （EventBridge のスケジュール。infra/lib/evaluation-stack.ts）が、同じ値を使う（Issue #77。ADR-0012）。
 * IaC から読み込まれるため、依存を持たない。
 */

/** 生成の間隔（分）。取り込みの既定の取得間隔（DEFAULT_INGESTION_INTERVAL_MINUTES の既定）と同じ。 */
export const DEMO_FEED_INTERVAL_MINUTES = 15;

/**
 * 1 つのファイル（取り込み元ごとの latest.json）に入れる、区間の数（現在を含む、直近の区間）。ファイルは、毎回、同じ名前に上書きする
 * （1 つのファイルを随時更新する方式。ADR-0016 の D-08）。同じ区間の記録は、同じ内容になる（取り込みは、値が変わった分だけ取り込む）。
 * 実行が数回、抜けても、直近の区間は、記録に含まれる。
 */
export const DEMO_FEED_BUCKETS = 4;

/** 生成の Lambda のタイムアウト（秒）。S3 への書き込みだけのため、短い。 */
export const DEMO_FEED_TIMEOUT_SECONDS = 60;

/** 温度の基準（℃）。デモのデータ（投入）と同じ。環境適応性が「注意」になり、通知の例が得られる。 */
export const DEMO_FEED_TEMPERATURE_BASE_CELSIUS = 26;

/** 合成データのファイルを置く、取り込み元の識別子（S3 の接頭辞。FileSourcePort のモックと同じ構成）。 */
export const DEMO_FEED_SOURCE_IDS = ['robot', 'environment-sensor'] as const;
export type DemoFeedSourceId = (typeof DEMO_FEED_SOURCE_IDS)[number];

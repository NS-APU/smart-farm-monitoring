/**
 * スモークテスト・性能の実測の結果ログ（test-result/smoketest.result.log）の組み立て。
 * 操作ごとの記録（records.jsonl。負荷テストと同じ形式・同じ許容時間）と、環境・取り込みログの実行時間から作る。
 * 環境の URL・ユーザーID・パスワードは、載せない（公開してよい内容だけ）。
 */

import {
  LIMITS,
  LIMIT_FACTOR,
  effectiveLimit,
  type LimitKey,
} from '../../stress/support/limits.ts';
import type { ActionRecord } from '../../stress/support/recorder.ts';
import { formatJst, percentile, summarize } from '../../stress/support/report-log.ts';

export interface SmokeEnvironmentInfo {
  readonly startedAt: string;
  readonly os: string;
  readonly node: string;
  readonly browser: string;
  readonly playwright: string;
}

/** 取り込みログ（GET /ingestion/logs）から求めた、取り込み 1 回の実行時間（秒）。 */
export interface JobDurations {
  readonly sourceId: string;
  readonly seconds: readonly number[];
  /** 実行時間の上限（Lambda のタイムアウト。秒）。 */
  readonly timeoutSeconds: number;
}

export interface SmokeReportInput {
  readonly records: readonly ActionRecord[];
  readonly environment: SmokeEnvironmentInfo;
  readonly jobDurations: readonly JobDurations[];
  readonly finishedAt: string;
}

function seconds(value: number): string {
  return value.toFixed(3);
}

function oneLine(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

/** 取り込み 1 回の実行時間の集計の行。上限に対する余裕（最大の実行時間が、上限の何 % か）を含む。 */
export function jobDurationLine(durations: JobDurations): string {
  if (durations.seconds.length === 0) {
    return `#   ${durations.sourceId}\t実行の記録なし`;
  }
  const max = Math.max(...durations.seconds);
  const ratio = (max / durations.timeoutSeconds) * 100;
  return [
    `#   ${durations.sourceId}`,
    `件数 ${String(durations.seconds.length)}`,
    `最大 ${seconds(max)} 秒`,
    `p50 ${seconds(percentile(durations.seconds, 0.5))} 秒`,
    `p95 ${seconds(percentile(durations.seconds, 0.95))} 秒`,
    `上限 ${String(durations.timeoutSeconds)} 秒に対する最大の割合 ${ratio.toFixed(1)} %`,
  ].join('\t');
}

export function buildSmokeReport(input: SmokeReportInput): string {
  const { records, environment } = input;
  const elapsed = (Date.parse(input.finishedAt) - Date.parse(environment.startedAt)) / 1000;
  const lines: string[] = [
    '# サーバーレス環境のスモークテスト・性能の実測 結果ログ（pnpm test:smoke）',
    `# 実行日時: ${formatJst(environment.startedAt)} 〜 ${formatJst(input.finishedAt)}（${elapsed.toFixed(0)} 秒）`,
    `# 実行した端末: OS ${environment.os} / Node ${environment.node} / ブラウザ ${environment.browser}（Playwright ${environment.playwright}、ヘッドレス、画面 1280x720）`,
    '# 時間は、端末のブラウザから見た時間（端末と環境の間の通信を含む）',
    '# 許容時間（tests/stress/support/limits.ts と同じ。応答時間・次の操作が可能になるまでの時間の、どちらも許容時間以内なら OK）:',
    ...(LIMIT_FACTOR === 1
      ? []
      : [`#   ※ 許容時間の係数 ${String(LIMIT_FACTOR)}（環境変数 STRESS_LIMIT_FACTOR）`]),
    ...(Object.keys(LIMITS) as LimitKey[]).map(
      (key) => `#   ${key}\t${String(effectiveLimit(key).seconds)} 秒\t${LIMITS[key].basis}`,
    ),
    '#',
    '# 列（タブ区切り）: No / 区分 / 操作 / 画面 / 応答(秒) / 次の操作可能(秒) / 許容(秒) / 判定 / 最も遅いAPI(ms) / そのAPI / 備考',
    [
      'No',
      '区分',
      '操作',
      '画面',
      '応答(秒)',
      '次の操作可能(秒)',
      '許容(秒)',
      '判定',
      'API最大(ms)',
      'API',
      '備考',
    ].join('\t'),
  ];
  for (const [index, record] of records.entries()) {
    lines.push(
      [
        String(index + 1),
        record.uc,
        oneLine(record.action),
        oneLine(record.screen),
        seconds(record.responseSeconds),
        seconds(record.readySeconds),
        String(record.limitSeconds),
        record.verdict,
        record.apiMaxMs === null ? '' : String(record.apiMaxMs),
        oneLine(record.apiPath),
        oneLine(record.note),
      ].join('\t'),
    );
  }
  const summary = summarize(records);
  lines.push(
    '',
    '# 集計（秒。p50・p95 は順位法）',
    `全体\t件数 ${String(summary.count)}\tOK ${String(summary.ok)}\tNG ${String(summary.ng)}`,
    `\t応答時間(秒)\t最大 ${seconds(summary.responseMax)}\tp50 ${seconds(summary.responseP50)}\tp95 ${seconds(summary.responseP95)}`,
    `\t次の操作可能まで(秒)\t最大 ${seconds(summary.readyMax)}\tp50 ${seconds(summary.readyP50)}\tp95 ${seconds(summary.readyP95)}`,
  );
  if (input.jobDurations.length > 0) {
    lines.push(
      '',
      '# 定期の取り込み（JB-01）の実行時間（取り込みログの開始〜終了。直近の記録）。Lambda のタイムアウトに対する余裕',
      ...input.jobDurations.map(jobDurationLine),
    );
  }
  const failed = records.filter((record) => record.verdict === 'NG');
  lines.push(
    '',
    `# 判定: ${failed.length === 0 ? `全 ${String(records.length)} 操作が許容時間内（NG 0 件）` : `NG ${String(failed.length)} 件（全 ${String(records.length)} 操作）`}`,
  );
  for (const record of failed) {
    lines.push(
      `#   NG\t${record.uc}\t${oneLine(record.action)}\t応答 ${seconds(record.responseSeconds)} 秒 / 次の操作可能 ${seconds(record.readySeconds)} 秒 / 許容 ${String(record.limitSeconds)} 秒\t${oneLine(record.note)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

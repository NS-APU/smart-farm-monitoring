/**
 * 結果ログ（test-result/stresstest.result.log）の組み立て。操作ごとの記録（records.jsonl）・データ規模（dataset.json）・
 * 環境（env.json）から、実行日時・環境・データ規模・許容時間・操作ごとの結果（タブ区切り）・集計（件数・OK/NG・最大・p50・p95）を作る。
 */

import type { ActionRecord, Scenario } from './recorder.ts';
import { LIMITS, LIMIT_FACTOR, effectiveLimit, type LimitKey } from './limits.ts';
import type { SeedSummary } from './seed-data.ts';

export interface EnvironmentInfo {
  readonly startedAt: string;
  readonly os: string;
  readonly node: string;
  readonly cpu: string;
  readonly cpuCores: number;
  readonly memoryGiB: number;
  readonly browser: string;
  readonly playwright: string;
  readonly frontend: string;
  readonly backend: string;
}

const SCENARIOS: readonly Scenario[] = ['単独利用', '同時接続', '大量取り込み'];

export function formatJst(iso: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} JST`;
}

/** 順位を使う分位数（nearest-rank 法）。 */
export function percentile(values: readonly number[], rate: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(rate * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

function seconds(value: number): string {
  return value.toFixed(3);
}

function oneLine(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

export interface Summary {
  readonly count: number;
  readonly ok: number;
  readonly ng: number;
  readonly responseMax: number;
  readonly responseP50: number;
  readonly responseP95: number;
  readonly readyMax: number;
  readonly readyP50: number;
  readonly readyP95: number;
}

export function summarize(records: readonly ActionRecord[]): Summary {
  const responses = records.map((record) => record.responseSeconds);
  const readies = records.map((record) => record.readySeconds);
  const ok = records.filter((record) => record.verdict === 'OK').length;
  return {
    count: records.length,
    ok,
    ng: records.length - ok,
    responseMax: Math.max(0, ...responses),
    responseP50: percentile(responses, 0.5),
    responseP95: percentile(responses, 0.95),
    readyMax: Math.max(0, ...readies),
    readyP50: percentile(readies, 0.5),
    readyP95: percentile(readies, 0.95),
  };
}

function summaryLines(label: string, summary: Summary): string[] {
  return [
    `${label}\t件数 ${String(summary.count)}\tOK ${String(summary.ok)}\tNG ${String(summary.ng)}`,
    `\t応答時間(秒)\t最大 ${seconds(summary.responseMax)}\tp50 ${seconds(summary.responseP50)}\tp95 ${seconds(summary.responseP95)}`,
    `\t次の操作可能まで(秒)\t最大 ${seconds(summary.readyMax)}\tp50 ${seconds(summary.readyP50)}\tp95 ${seconds(summary.readyP95)}`,
  ];
}

function datasetLines(dataset: SeedSummary | undefined): string[] {
  if (dataset === undefined) {
    return ['# データ規模: （dataset.json がありません）'];
  }
  const houses = dataset.scale.houses
    .map(
      (house) =>
        `${house.houseId}（ロボット${String(house.units)}台・センサー${String(house.units)}台・${String(house.intervalMinutes)}分間隔）`,
    )
    .join('、');
  return [
    '# データ規模（テストの起動時に、合成データを生成して投入。実データ・個人情報は使わない）:',
    `#   設備: ハウス ${String(dataset.equipment.houses)}・ロボット ${String(dataset.equipment.robots)}・センサー ${String(dataset.equipment.sensors)}（${houses}）`,
    `#   観測値: ${dataset.observationsTotal.toLocaleString('en-US')} 件（自動取り込み ${dataset.autoObservations.toLocaleString('en-US')} 件 + 手動入力 ${dataset.manualObservations.toLocaleString('en-US')} 件）、期間 ${formatJst(dataset.historyFrom)} 〜 ${formatJst(dataset.historyTo)}（${String(dataset.scale.historyDays)}日）`,
    `#   手動入力 ${dataset.manualEntries.toLocaleString('en-US')} 件、通知 ${dataset.notifications.toLocaleString('en-US')} 件（未読 ${dataset.unreadNotifications.toLocaleString('en-US')} 件）、変更履歴 ${dataset.auditLogs.toLocaleString('en-US')} 件、ステータスの変化の履歴 ${dataset.statusChanges.toLocaleString('en-US')} 件`,
    `#   ステータスコード ${String(dataset.statusCodesTotal)} 件、取り込みログ ${dataset.ingestionLogs.toLocaleString('en-US')} 件、取り込み済みファイルの記録 ${dataset.ingestedFileRecords.toLocaleString('en-US')} 件、連携キュー ${dataset.federationItems.toLocaleString('en-US')} 件、連携ログ ${dataset.federationLogs.toLocaleString('en-US')} 件、利用者 ${String(dataset.users)} 人`,
    `#   投入に要した時間: ${dataset.seedSeconds.toFixed(1)} 秒`,
  ];
}

export interface ResultLogInput {
  readonly records: readonly ActionRecord[];
  readonly dataset: SeedSummary | undefined;
  readonly environment: EnvironmentInfo;
  readonly finishedAt: string;
}

/** 結果ログの全文を作る。 */
export function buildResultLog(input: ResultLogInput): string {
  const { records, dataset, environment } = input;
  const elapsedSeconds = (Date.parse(input.finishedAt) - Date.parse(environment.startedAt)) / 1000;
  const lines: string[] = [
    '# 負荷テスト結果ログ（pnpm test:stress）',
    `# 実行日時: ${formatJst(environment.startedAt)} 〜 ${formatJst(input.finishedAt)}（${elapsedSeconds.toFixed(0)} 秒）`,
    `# 環境: OS ${environment.os} / Node ${environment.node} / CPU ${environment.cpu}（${String(environment.cpuCores)} 論理コア）/ メモリ ${environment.memoryGiB.toFixed(1)} GiB`,
    `#   ブラウザ ${environment.browser}（Playwright ${environment.playwright}、ヘッドレス、画面 1280x720）/ フロントエンド ${environment.frontend} / バックエンド ${environment.backend}`,
    ...datasetLines(dataset),
    '# 許容時間（tests/stress/support/limits.ts。応答時間・次の操作が可能になるまでの時間の、どちらも許容時間以内なら OK）:',
    ...(LIMIT_FACTOR === 1
      ? []
      : [
          `#   ※ 許容時間の係数 ${String(LIMIT_FACTOR)}（環境変数 STRESS_LIMIT_FACTOR。実行環境の速さの揺れを吸収するため、NFR の値に、この倍率をかけた）`,
        ]),
    ...(Object.keys(LIMITS) as LimitKey[]).map((key) => {
      const limit = effectiveLimit(key);
      const factorNote =
        LIMIT_FACTOR === 1
          ? ''
          : `（NFR の値 ${String(LIMITS[key].seconds)} 秒 × ${String(LIMIT_FACTOR)}）`;
      return `#   ${key}\t${String(limit.seconds)} 秒${factorNote}\t${limit.basis}`;
    }),
    '#',
    '# 列（タブ区切り）: No / シナリオ / UC / 操作 / 画面 / 利用者 / 応答(秒) / 次の操作可能(秒) / 許容(秒) / 判定 / 最も遅いAPI(ms) / そのAPI / 備考',
    [
      'No',
      'シナリオ',
      'UC',
      '操作',
      '画面',
      '利用者',
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
        record.scenario,
        record.uc,
        oneLine(record.action),
        oneLine(record.screen),
        record.user,
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
  lines.push('', '# 集計（応答時間・次の操作が可能になるまでの時間。秒。p50・p95 は順位法）');
  lines.push(...summaryLines('全体', summarize(records)));
  for (const scenario of SCENARIOS) {
    const part = records.filter((record) => record.scenario === scenario);
    if (part.length > 0) {
      lines.push(...summaryLines(scenario, summarize(part)));
    }
  }
  const failed = records.filter((record) => record.verdict === 'NG');
  lines.push(
    '',
    `# 判定: ${failed.length === 0 ? `全 ${String(records.length)} 操作が許容時間内（NG 0 件）` : `NG ${String(failed.length)} 件（全 ${String(records.length)} 操作）`}`,
  );
  for (const record of failed) {
    lines.push(
      `#   NG\t${record.scenario}\t${record.uc}\t${oneLine(record.action)}\t応答 ${seconds(record.responseSeconds)} 秒 / 次の操作可能 ${seconds(record.readySeconds)} 秒 / 許容 ${String(record.limitSeconds)} 秒\t${oneLine(record.note)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

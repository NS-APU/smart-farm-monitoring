/**
 * 観点の画面（UC-01〜UC-04、UC-21）の E2E の補助: 時計の固定、データの投入（開発用 API）、状態ごとの値（同値分割）、
 * スクリーンショットとレイアウトの検査。
 *
 * 値は、docs/10_design/viewpoint/ の判断基準（閾値）から、手計算で選ぶ。評価のコードを呼び出して期待値を作らない。
 * データは、直近24時間の中にだけ置く（短期・長期の両方で、同じ値になり、観点のステータスが読み取りやすい）。
 */

import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { LoginResponseSchema } from '../../../src/shared/schemas/auth.ts';
import { E2E_USER } from './e2e-user.ts';

export const HOUSE = 'HOUSE-01';
export const ROBOT = 'ROBOT-01';
export const SENSOR = 'SENSOR-01';

/** 固定する現在時刻（2026-10-09 12:00 JST）。 */
export const NOW = new Date('2026-10-09T03:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type Level = 'NORMAL' | 'CAUTION' | 'ERROR';

export function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

export interface SeededObservation {
  readonly equipmentId: string;
  readonly itemKey: string;
  readonly observedAt: string;
  readonly value: number | string | null;
  readonly source?: 'AUTO_IMPORT' | 'MANUAL';
  readonly quality?: 'VALID' | 'MISSING' | 'LATE' | 'INVALID';
  readonly receivedAt?: string;
}

export interface SeededSeries {
  readonly equipmentId: string;
  readonly itemKey: string;
  readonly from: string;
  readonly to: string;
  readonly intervalMinutes: number;
  readonly value: number | string | null;
  readonly source?: 'AUTO_IMPORT' | 'MANUAL';
  readonly quality?: 'VALID' | 'MISSING' | 'LATE' | 'INVALID';
}

export interface SeedBody {
  readonly observations?: readonly SeededObservation[];
  readonly series?: readonly SeededSeries[];
  readonly evaluate?: boolean;
}

/** 本文を合わせる。 */
export function merge(...bodies: readonly SeedBody[]): SeedBody {
  return {
    observations: bodies.flatMap((body) => body.observations ?? []),
    series: bodies.flatMap((body) => body.series ?? []),
  };
}

/** API で、E2E のユーザーとしてログインし、アクセストークンを返す。 */
export async function apiToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/v1/auth/login', {
    data: { userId: E2E_USER.userId, password: E2E_USER.password },
  });
  expect(login.ok()).toBe(true);
  return LoginResponseSchema.parse(await login.json()).accessToken;
}

async function call(
  request: APIRequestContext,
  method: 'POST' | 'PUT',
  path: string,
  data: unknown,
): Promise<void> {
  const token = await apiToken(request);
  const response = await request.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `${method} ${path}: ${String(response.status())}`).toBe(true);
}

export interface PrepareOptions {
  /** デモの設備（ハウス・ロボット・センサー）を入れるか。既定は入れる。false は、設備が1つもない状態。 */
  readonly equipment?: boolean;
  /** 固定する現在時刻（既定は NOW）。 */
  readonly now?: Date;
}

/** データを初期化し、時計を固定する（テストごとに最初に呼ぶ）。 */
export async function prepare(
  request: APIRequestContext,
  options: PrepareOptions = {},
): Promise<void> {
  await call(request, 'POST', '/dev/reset', {
    seed: options.equipment === false ? 'NONE' : 'EQUIPMENT',
  });
  await setClock(request, options.now ?? NOW);
}

export async function setClock(request: APIRequestContext, at: Date): Promise<void> {
  await call(request, 'PUT', '/dev/clock', { at: at.toISOString(), mode: 'FREEZE' });
}

/** 観測値を投入し、評価を更新する（取り込み・手動入力の保存後と同じ）。 */
export async function seed(request: APIRequestContext, body: SeedBody): Promise<void> {
  await call(request, 'POST', '/dev/observations', { evaluate: true, ...body });
}

/** 評価の定期実行（JB-02）を起動する。 */
export async function runEvaluation(request: APIRequestContext): Promise<void> {
  await call(request, 'POST', '/dev/jobs/JB-02/run', {});
}

// ---------------------------------------------------------------------------
// 観点ごとの値（同値分割）。直近24時間の中に置く。
// ---------------------------------------------------------------------------

/** 1時間ごとの系列（23時間前〜1時間前）。 */
function hourly(
  equipmentId: string,
  itemKey: string,
  value: number | string,
  options: { from?: number; to?: number; source?: 'AUTO_IMPORT' | 'MANUAL' } = {},
): SeededSeries {
  return {
    equipmentId,
    itemKey,
    from: hoursAgo(options.from ?? 23),
    to: hoursAgo(options.to ?? 1),
    intervalMinutes: 60,
    value,
    ...(options.source === undefined ? {} : { source: options.source }),
  };
}

/** 15分ごとの系列（データ活用度合いの「取得できた間隔」を満たす）。 */
function quarterHourly(
  equipmentId: string,
  itemKey: string,
  value: number | string,
  options: { from?: number; to?: number } = {},
): SeededSeries {
  return {
    equipmentId,
    itemKey,
    from: hoursAgo(options.from ?? 23),
    to: hoursAgo(options.to ?? 1),
    intervalMinutes: 15,
    value,
  };
}

function manual(equipmentId: string, itemKey: string, value: number, hours = 1): SeededObservation {
  return { equipmentId, itemKey, observedAt: hoursAgo(hours), value, source: 'MANUAL' };
}

function auto(
  equipmentId: string,
  itemKey: string,
  value: number | string,
  hours = 1,
): SeededObservation {
  return { equipmentId, itemKey, observedAt: hoursAgo(hours), value };
}

/** 環境（温度・湿度・照度・CO2濃度）。省略した項目は、正常な値。null は、その項目を入れない。 */
export function environmentData(
  values: {
    temperature?: number | null;
    humidity?: number | null;
    illuminance?: number | null;
    co2?: number | null;
  } = {},
  hours = 1,
): SeedBody {
  const entries: [string, number | null | undefined, number][] = [
    ['temperatureCelsius', values.temperature, 20],
    ['humidityPercent', values.humidity, 60],
    ['illuminanceLux', values.illuminance, 30_000],
    ['co2Ppm', values.co2, 900],
  ];
  return {
    observations: entries.flatMap(([itemKey, value, normal]) => {
      const resolved = value === undefined ? normal : value;
      return resolved === null ? [] : [auto(SENSOR, itemKey, resolved, hours)];
    }),
  };
}

/** 収穫精度（収穫数 230 に対して、損傷・誤収穫・取り残し）。可販果率 = 100 − (損傷 + 誤収穫) ÷ 230 × 100。 */
export function harvestAccuracyData(level: Level): SeedBody {
  // 正常: (2+1)/230 → 98.7%、注意: (16+8)/230 → 89.6%、異常: (40+10)/230 → 78.3%
  const counts = {
    NORMAL: { damaged: 2, wrong: 1, missed: 3 },
    CAUTION: { damaged: 16, wrong: 8, missed: 3 },
    ERROR: { damaged: 40, wrong: 10, missed: 3 },
  }[level];
  return {
    series: [hourly(ROBOT, 'harvestCount', 10)],
    observations: [
      manual(ROBOT, 'damagedFruitCount', counts.damaged),
      manual(ROBOT, 'wrongHarvestCount', counts.wrong),
      manual(ROBOT, 'missedFruitCount', counts.missed),
    ],
  };
}

/** 収穫精度の境界値: 収穫数 100（1件）に対して、損傷 + 誤収穫を指定する。 */
export function harvestAccuracyBoundary(damaged: number, wrong: number): SeedBody {
  return {
    observations: [
      auto(ROBOT, 'harvestCount', 100),
      manual(ROBOT, 'damagedFruitCount', damaged),
      manual(ROBOT, 'wrongHarvestCount', wrong),
      manual(ROBOT, 'missedFruitCount', 0),
    ],
  };
}

/** 収穫速度。1果実あたりの平均処理時間 = 収穫稼働時間 × 3600 ÷ 収穫数。 */
export function harvestSpeedData(level: Level, statusCode = 'HARVESTING'): SeedBody {
  // 収穫数 10/時間。収穫稼働時間 0.1h → 36秒（正常）、0.18h → 64.8秒（注意）、0.4h → 144秒（異常）。走行停止率は 2%（正常）
  const operatingHours = { NORMAL: 0.1, CAUTION: 0.18, ERROR: 0.4 }[level];
  return {
    series: [
      hourly(ROBOT, 'harvestCount', 10),
      hourly(ROBOT, 'harvestOperatingHours', operatingHours),
      hourly(ROBOT, 'travelStoppedHours', Number((operatingHours * 0.02).toFixed(5))),
      hourly(ROBOT, 'statusCode', statusCode),
    ],
  };
}

/** 収穫速度の境界値: 収穫稼働時間 1h に対する走行停止時間（走行停止率 = 停止 ÷ 稼働 × 100）。 */
export function travelStoppedBoundary(stoppedHours: number): SeedBody {
  return {
    observations: [
      auto(ROBOT, 'harvestCount', 100),
      auto(ROBOT, 'harvestOperatingHours', 1.0),
      auto(ROBOT, 'travelStoppedHours', stoppedHours),
      auto(ROBOT, 'statusCode', 'HARVESTING'),
    ],
  };
}

/** 操作性。操作ステップ数（5以上 注意、10以上 異常）、操作時間（10分以上 注意、30分以上 異常）、操作エラー率。 */
export function operabilityData(level: Level): SeedBody {
  const values = {
    NORMAL: { steps: 4, minutes: 8, errors: 0 },
    CAUTION: { steps: 7, minutes: 15, errors: 1 },
    ERROR: { steps: 12, minutes: 35, errors: 5 },
  }[level];
  return {
    observations: [
      manual(ROBOT, 'operationStepCount', values.steps),
      manual(ROBOT, 'operationMinutes', values.minutes),
      manual(ROBOT, 'operationErrorCount', values.errors),
    ],
  };
}

/** メンテナンス性。MTTR（時間）= 復旧に要した時間（分）÷ 60 ÷ 故障回数。4時間以上 注意、8時間以上 異常。 */
export function maintainabilityData(level: Level, statusCode = 'STANDBY'): SeedBody {
  const recoveryMinutes = { NORMAL: 90, CAUTION: 300, ERROR: 600 }[level];
  return {
    observations: [
      manual(ROBOT, 'failureCount', 1),
      manual(ROBOT, 'recoveryMinutes', recoveryMinutes),
      auto(ROBOT, 'statusCode', statusCode),
    ],
  };
}

/** 安全性。緊急停止頻度 = 緊急停止回数 ÷ 稼働時間（0.01回/時間以上 注意、0.05以上 異常）。稼働時間は 23時間。 */
export function safetyData(level: Level): SeedBody {
  const emergencyStops = { NORMAL: 0, CAUTION: 1, ERROR: 2 }[level];
  return {
    series: [hourly(ROBOT, 'operatingHours', 1)],
    observations: [
      manual(ROBOT, 'emergencyStopCount', emergencyStops),
      manual(ROBOT, 'nearMissCount', 0),
    ],
  };
}

/** 耐久性。MTBF（時間）= 稼働時間 ÷ 故障回数（100時間未満 異常、500時間未満 注意）。稼働時間は、1時間あたりの値で決める。 */
export function durabilityData(level: Level, statusCode = 'STANDBY'): SeedBody {
  // 23サンプル × 値 = 稼働時間。正常: 600h（26.09 × 23）、注意: 300h、異常: 23h（1 × 23）
  const hoursPerSample = { NORMAL: 26.1, CAUTION: 13, ERROR: 1 }[level];
  return {
    series: [hourly(ROBOT, 'operatingHours', hoursPerSample)],
    observations: [
      manual(ROBOT, 'failureCount', 1),
      manual(ROBOT, 'recoveryMinutes', 60),
      auto(ROBOT, 'statusCode', statusCode),
    ],
  };
}

/** コスト効率に必要な、すべての入力（値は、判断基準が「異常」になる、現実的な値）。 */
export function costEfficiencyData(): SeedBody {
  return {
    series: [
      hourly(ROBOT, 'harvestCount', 10),
      hourly(ROBOT, 'harvestOperatingHours', 0.1),
      hourly(ROBOT, 'operatingHours', 1),
    ],
    observations: [
      manual(ROBOT, 'damagedFruitCount', 2),
      manual(ROBOT, 'wrongHarvestCount', 1),
      manual(ROBOT, 'failureCount', 1),
      manual(ROBOT, 'recoveryMinutes', 60),
      manual(ROBOT, 'robotCostYenPerHour', 300),
      manual(ROBOT, 'laborCostYenPerHour', 1200),
      manual(ROBOT, 'maintenanceCostYen', 500),
      manual(ROBOT, 'electricityCostYen', 400),
    ],
  };
}

/** データ活用度合い。ロボット・センサー・手動入力の取得の割合。 */
export function dataUtilizationData(level: Level): SeedBody {
  // 15分ごとの間隔に対する、取得できた間隔の割合。ロボットは全期間、センサーは期間の一部（正常: 全期間、注意: 約半分、異常: なし）
  const sensor = {
    NORMAL: [quarterHourly(SENSOR, 'temperatureCelsius', 20)],
    CAUTION: [quarterHourly(SENSOR, 'temperatureCelsius', 20, { from: 13 })],
    ERROR: [],
  }[level];
  return {
    series: [quarterHourly(ROBOT, 'harvestCount', 10), ...sensor],
    observations: [manual(ROBOT, 'failureCount', 1)],
  };
}

/** 満足度（9観点の 1〜5 スター。値の数が9未満なら、後ろの観点が未入力）。ハウスに紐づける。 */
export const SATISFACTION_ITEMS = [
  'harvestAccuracy',
  'harvestSpeed',
  'environmentalAdaptability',
  'operability',
  'maintainability',
  'costEfficiency',
  'safety',
  'dataUtilization',
  'durability',
] as const;

export function satisfactionData(scores: readonly (number | null)[], hours = 1): SeedBody {
  return {
    observations: SATISFACTION_ITEMS.flatMap((viewpointId, index) => {
      const score = scores[index];
      return score === undefined || score === null
        ? []
        : [manual(HOUSE, `satisfaction.${viewpointId}`, score, hours)];
    }),
  };
}

// ---------------------------------------------------------------------------
// スクリーンショットとレイアウトの検査
// ---------------------------------------------------------------------------

/** 重なりを調べる要素のグループ。 */
const NO_OVERLAP_SELECTORS = [
  '.viewpoint-card',
  '.summary li',
  '.panel',
  '.horizon-card',
  '.feedback-card',
  '.trend-metric',
  '.score-table tr',
  '.app-header-row > *',
  '.filter-bar .field',
  '.form-grid .field',
  '.queue-counts li',
  '.source-card',
  '.criterion-card',
  '.related-statuses li',
  '.dialog',
  '.login-page > *',
  '.login-form > *',
] as const;

/** はみ出し（文字が箱からあふれる）を調べる要素。 */
const NO_CLIP_SELECTORS = [
  'h1',
  'h2',
  'h3',
  '.status-badge',
  'button',
  '.tag',
  '.summary li',
  '.status-segment',
] as const;

interface LayoutProblem {
  readonly kind: string;
  readonly detail: string;
}

/**
 * レイアウトの検査（余計な隙間・要素の重なり・偏りの機械的な確認。画像の目視の補助）。
 * - 横スクロールがない
 * - 同じ種類の要素が重ならない
 * - 要素が表示領域の左右にはみ出さない
 * - 見出し・バッジ・ボタンの文字が、箱からあふれない
 * - 並んだカードの上端・高さが揃っている（同じ行のカードの高さの差が小さい）
 * - 表の列が極端に細くない（文字が1文字ずつ縦に折り返されない）
 * - ページの下に、余計な空白（見える要素の下端より下の、スクロールできる範囲）がない
 */
export async function expectCleanLayout(page: Page): Promise<void> {
  const problems = await page.evaluate(
    ({ overlapSelectors, clipSelectors }) => {
      const found: { kind: string; detail: string }[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) {
        found.push({
          kind: 'horizontal-scroll',
          detail: `scrollWidth=${String(root.scrollWidth)} clientWidth=${String(root.clientWidth)}`,
        });
      }
      // ページの下の余計な空白: 文書の高さが、見える要素の下端より大きい（見えない要素が、文書の高さを伸ばしている）。
      // 画面に収まるページ（スクロールしない）は、対象外
      if (root.scrollHeight > window.innerHeight + 1) {
        let contentBottom = 0;
        for (const element of document.body.querySelectorAll('*')) {
          const style = getComputedStyle(element);
          if (
            element.closest('.visually-hidden') !== null ||
            style.position === 'fixed' ||
            style.display === 'none'
          ) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            contentBottom = Math.max(contentBottom, rect.bottom + window.scrollY);
          }
        }
        if (root.scrollHeight - contentBottom > 64) {
          found.push({
            kind: 'extra-bottom-space',
            detail: `scrollHeight=${String(root.scrollHeight)} contentBottom=${String(Math.round(contentBottom))}`,
          });
        }
      }
      const visible = (element: Element): DOMRect | null => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' ? rect : null;
      };
      for (const selector of overlapSelectors) {
        const rects = [...document.querySelectorAll(selector)]
          .map((element) => ({ element, rect: visible(element) }))
          .filter((item): item is { element: Element; rect: DOMRect } => item.rect !== null);
        for (let i = 0; i < rects.length; i += 1) {
          const a = rects[i];
          if (a === undefined) {
            continue;
          }
          if (a.rect.left < -1 || a.rect.right > root.clientWidth + 1) {
            found.push({
              kind: 'out-of-viewport',
              detail: `${selector}[${String(i)}] left=${String(a.rect.left)} right=${String(a.rect.right)}`,
            });
          }
          for (let j = i + 1; j < rects.length; j += 1) {
            const b = rects[j];
            if (b === undefined) {
              continue;
            }
            const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const height =
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (width > 1 && height > 1) {
              found.push({ kind: 'overlap', detail: `${selector}[${String(i)}] x [${String(j)}]` });
            }
          }
        }
      }
      for (const selector of clipSelectors) {
        document.querySelectorAll(selector).forEach((element, index) => {
          if (visible(element) !== null && element.scrollWidth > element.clientWidth + 1) {
            found.push({ kind: 'clipped-text', detail: `${selector}[${String(index)}]` });
          }
        });
      }
      // 表の列が極端に細く、文字が1文字ずつ縦に折り返されない（内容の幅が、文字2つ分より小さい）
      document.querySelectorAll('td, th').forEach((cell, index) => {
        const text = cell.textContent.trim();
        if (
          text.length < 3 ||
          cell.closest('.visually-hidden') !== null ||
          visible(cell) === null
        ) {
          return;
        }
        const style = getComputedStyle(cell);
        const contentWidth =
          cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (contentWidth < parseFloat(style.fontSize) * 2) {
          found.push({
            kind: 'squeezed-cell',
            detail: `${cell.tagName.toLowerCase()}[${String(index)}] "${text.slice(0, 12)}" width=${String(Math.round(contentWidth))}`,
          });
        }
      });
      // 同じ行（上端が近い）のカードは、高さが揃っている
      const cards = [...document.querySelectorAll('.viewpoint-card')]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
      for (const rect of cards) {
        const sameRow = cards.filter((other) => Math.abs(other.top - rect.top) < 2);
        if (sameRow.some((other) => Math.abs(other.height - rect.height) > 2)) {
          found.push({ kind: 'uneven-card-height', detail: `top=${String(rect.top)}` });
        }
      }
      return found;
    },
    { overlapSelectors: [...NO_OVERLAP_SELECTORS], clipSelectors: [...NO_CLIP_SELECTORS] },
  );
  expect(problems as LayoutProblem[], 'レイアウトの問題').toEqual([]);
}

/** 画面ごとのスクリーンショット（ページ全体）を保存し、レイアウトを検査する。 */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectCleanLayout(page);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** 観点の表示順と名称（evaluation.md 1章）。 */
export const VIEWPOINT_ORDER = [
  ['harvestAccuracy', '収穫精度'],
  ['harvestSpeed', '収穫速度'],
  ['environmentalAdaptability', '環境適応性'],
  ['operability', '操作性'],
  ['maintainability', 'メンテナンス性'],
  ['costEfficiency', 'コスト効率'],
  ['safety', '安全性'],
  ['dataUtilization', 'データ活用度合い'],
  ['durability', '耐久性'],
  ['satisfaction', '満足度'],
] as const;

export type ExpectedStatus = '正常' | '注意' | '異常' | '不明';

/**
 * 4つのステータスが混在するデータ（ハウス）。観点ごとの期待値（判断基準から手計算）:
 * 収穫精度＝正常、収穫速度＝注意、環境適応性＝異常、操作性＝不明（データなし）、メンテナンス性＝正常、
 * コスト効率＝不明（コストの入力なし）、安全性＝注意、データ活用度合い＝異常（取得が間引かれている）、耐久性＝異常（稼働時間 23h）、満足度＝不明。
 */
export function mixedScenario(): SeedBody {
  return merge(
    harvestAccuracyData('NORMAL'),
    harvestSpeedData('CAUTION'),
    environmentData({ temperature: 40 }),
    maintainabilityData('NORMAL', 'HARVESTING'),
    safetyData('CAUTION'),
  );
}

export const MIXED_EXPECTED: Readonly<Record<(typeof VIEWPOINT_ORDER)[number][0], ExpectedStatus>> =
  {
    harvestAccuracy: '正常',
    harvestSpeed: '注意',
    environmentalAdaptability: '異常',
    operability: '不明',
    maintainability: '正常',
    costEfficiency: '不明',
    safety: '注意',
    dataUtilization: '異常',
    durability: '異常',
    satisfaction: '不明',
  };

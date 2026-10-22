/**
 * 性能の実測（サーバーレス環境。Issue #79。ADR-0002 の「実測で確認する」）。端末のブラウザから見た時間を、許容時間（NFR。負荷テストと同じ）と比べる。
 *
 * - NFR-3.4 ダッシュボードの初期表示（3 秒）: 新しいブラウザの状態から、ログイン → ダッシュボードの表示まで。複数回
 * - NFR-3.5 推移の表示（直近 30 日。10 秒）: 観点の詳細で、期間を切り替える。**1 か月分のデータが要る**
 *   （`pnpm demo-data seed --days 30` で投入した状態で測る。既定の 3 日分では、1 か月分の測定にならない）
 * - NFR-3.3 画面の自動更新（約 10 秒ごと）: ダッシュボードの再取得を、複数回
 * - 定期の取り込み（JB-01）の実行時間: 取り込みログ（API）の、開始〜終了。Lambda のタイムアウトに対する余裕
 *
 * ほかのジョブ（JB-02〜04）の実行時間と、Lambda の起動の時間（Init Duration）は、CloudWatch Logs で見る（docs/40_operations/operations.md）。
 * コールドスタートの影響は、smoke-03（SMOKE_COLD_START=1）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { LoginResponseSchema } from '../../src/shared/schemas/auth.ts';
import { IngestionLogListResponseSchema } from '../../src/shared/schemas/ingestion.ts';
import { JOB_LAMBDA_TIMEOUT_SECONDS } from '../../src/backend/application/jobs/job-schedule.ts';
import type { LimitKey } from '../stress/support/limits.ts';
import { measure, measureRefresh, trackApi, type ActionSteps } from '../stress/support/recorder.ts';
import { JOB_DURATIONS_PATH } from './support/global-setup.ts';
import type { JobDurations } from './support/smoke-report.ts';
import {
  expectDashboardShown,
  expectDetailShown,
  fillLogin,
  loginButton,
  openLogin,
  smokeEnv,
} from './support/smoke-ui.ts';

/** 初期表示の計測の回数。 */
const INITIAL_DISPLAY_RUNS = 5;
/** 推移の表示の計測の回数（期間を、30 日 → 7 日 → 30 日… と切り替える）。 */
const TREND_RUNS = 3;
/** 自動更新の計測の回数。 */
const REFRESH_RUNS = 3;
/** 取り込みログから見る、直近の件数。 */
const LOG_COUNT = 50;
const INGESTION_SOURCE_IDS = ['robot', 'environment-sensor'] as const;

function measurer(page: Page, note?: string) {
  trackApi(page);
  return (
    uc: string,
    action: string,
    screen: string,
    limit: LimitKey,
    steps: ActionSteps,
  ): Promise<unknown> =>
    measure(page, { uc, action, screen, limit }, note === undefined ? steps : { ...steps, note });
}

test('NFR-3.4 ダッシュボードの初期表示: 新しいブラウザの状態から、ログインして、ダッシュボードを表示する（複数回）', async ({
  browser,
}) => {
  for (let run = 1; run <= INITIAL_DISPLAY_RUNS; run += 1) {
    // ブラウザの状態（保存された認証・キャッシュ）を引き継がない
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const m = measurer(page, `${String(run)}/${String(INITIAL_DISPLAY_RUNS)} 回目`);
      await openLogin(page);
      await fillLogin(page);
      await m(
        'NFR-3.4',
        'ログインして、ダッシュボードを表示する（新しいブラウザの状態）',
        'ログイン（SC-01）→ ダッシュボード（SC-02）',
        'dashboardInitial',
        {
          act: () => loginButton(page).click(),
          respond: () => expectDashboardShown(page),
        },
      );
    } finally {
      await context.close();
    }
  }
});

test('NFR-3.5 推移の表示・NFR-3.3 自動更新: 観点の詳細で、期間（直近 30 日）を切り替え、ダッシュボードの自動更新を測る', async ({
  page,
}) => {
  const m = measurer(page);
  await openLogin(page);
  await fillLogin(page);
  await loginButton(page).click();
  await expectDashboardShown(page);

  // NFR-3.3 約 10 秒ごとの自動更新（ダッシュボードの再取得）
  for (let run = 1; run <= REFRESH_RUNS; run += 1) {
    await measureRefresh(
      page,
      {
        uc: 'NFR-3.3',
        action: `画面の自動更新（約 10 秒ごと。ダッシュボードの再取得）${String(run)}/${String(REFRESH_RUNS)} 回目`,
        screen: 'ダッシュボード（SC-02）',
        limit: 'refresh',
      },
      '/dashboard',
    );
  }

  // NFR-3.5 推移の表示
  await m('UC-02', '観点「環境適応性」の詳細を開く', '観点の詳細（SC-03）', 'screen', {
    act: () =>
      page
        .getByTestId('card-environmentalAdaptability')
        .getByRole('heading')
        .getByRole('link')
        .click(),
    respond: () => expectDetailShown(page),
  });
  for (let run = 1; run <= TREND_RUNS; run += 1) {
    await m(
      'NFR-3.5',
      `推移の期間を「直近30日」に切り替える（${String(run)}/${String(TREND_RUNS)} 回目）`,
      '観点の詳細・推移（SC-03）',
      'trend',
      {
        act: () => page.getByLabel('長期の期間').selectOption({ label: '直近30日' }),
        respond: async () => {
          await expectDetailShown(page);
          await expect(page.getByTestId('trend')).toContainText('（日ごと）');
        },
      },
    );
    await m('UC-03', '推移の期間を「直近7日」に戻す', '観点の詳細・推移（SC-03）', 'trend', {
      act: () => page.getByLabel('長期の期間').selectOption({ label: '直近7日' }),
      respond: () => expectDetailShown(page),
    });
  }
});

test('JB-01 定期の取り込みの実行時間: 取り込みログ（API）の開始〜終了を、Lambda のタイムアウトと比べる', async ({
  request,
}) => {
  const { userId, password } = smokeEnv();
  const login = await request.post('/api/v1/auth/login', { data: { userId, password } });
  expect(login.ok(), 'API のログイン').toBe(true);
  const { accessToken } = LoginResponseSchema.parse(await login.json());
  const durations: JobDurations[] = [];
  for (const sourceId of INGESTION_SOURCE_IDS) {
    const response = await request.get(
      `/api/v1/ingestion/logs?sourceId=${sourceId}&limit=${String(LOG_COUNT)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(response.ok(), `取り込みログの取得（${sourceId}）`).toBe(true);
    const { items } = IngestionLogListResponseSchema.parse(await response.json());
    durations.push({
      sourceId,
      seconds: items.map((log) => (Date.parse(log.finishedAt) - Date.parse(log.startedAt)) / 1000),
      timeoutSeconds: JOB_LAMBDA_TIMEOUT_SECONDS,
    });
  }
  mkdirSync(dirname(JOB_DURATIONS_PATH), { recursive: true });
  writeFileSync(JOB_DURATIONS_PATH, JSON.stringify(durations, null, 2), 'utf8');
  // 実行の記録が 1 件もなければ、実測にならない（ジョブが動いていない可能性）。許容は、タイムアウトの範囲内
  for (const item of durations) {
    expect(item.seconds.length, `${item.sourceId} の取り込みログがある`).toBeGreaterThan(0);
    expect(
      Math.max(...item.seconds),
      `${item.sourceId} の実行時間が、タイムアウト以内`,
    ).toBeLessThan(item.timeoutSeconds);
  }
});

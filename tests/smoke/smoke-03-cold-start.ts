/**
 * コールドスタートの影響の実測（サーバーレス環境。Issue #79。ADR-0002 の「実測で確認する」）。
 *
 * API の Lambda が、しばらく使われず、停止している状態（コールドスタート）で、ダッシュボードの初期表示が間に合うかを測る。
 * 許容は、NFR-3.4 のとおり、**1 回目（コールドスタートの可能性）は 6 秒以内、2 回目（ウォーム）は 3 秒以内**（Issue #168）。
 * Lambda の実行環境が、いつ停止するかは、AWS が決める。**この環境に、60 分以上、アクセスがない状態にしてから、実行する**
 * （自動の実行の対象外。`SMOKE_COLD_START=1` を付けたときだけ動く）。Lambda 側の起動の時間（Init Duration）は、CloudWatch Logs で見る
 * （docs/40_operations/operations.md）。
 *
 * 記録は、1 回目（コールドスタートの可能性）と、続けて測った 2 回目（ウォーム）の、両方を残す。
 * 1 回目が、実際にはコールドスタートでなかった（実行環境が温まっていた）場合も、6 秒以内なら成功になる。
 * その場合の見分け方は、CloudWatch Logs の Init Duration の有無（operations.md 7.7）。
 */

import { expect, test } from '@playwright/test';
import type { LimitKey } from '../stress/support/limits.ts';
import { measure, trackApi, type ActionSteps } from '../stress/support/recorder.ts';
import { expectDashboardShown, fillLogin, loginButton, openLogin } from './support/smoke-ui.ts';

test.skip(
  process.env.SMOKE_COLD_START !== '1',
  'SMOKE_COLD_START=1 のときだけ実行する（60 分以上、アクセスがない状態で）',
);

test('NFR-3.4 コールドスタート: 長く使われていない状態で、ログインして、ダッシュボードを表示する（1 回目と 2 回目）', async ({
  browser,
}) => {
  for (const run of [1, 2]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      trackApi(page);
      await openLogin(page);
      await fillLogin(page);
      // 1 回目: コールドスタートの許容（6 秒）。2 回目: 通常（3 秒）
      const limit: LimitKey = run === 1 ? 'dashboardColdStart' : 'dashboardInitial';
      const steps: ActionSteps = {
        act: () => loginButton(page).click(),
        respond: () => expectDashboardShown(page),
        note:
          run === 1
            ? '1 回目（アクセスのない状態の後。コールドスタートの可能性）'
            : '2 回目（続けて測った。ウォーム）',
      };
      await measure(
        page,
        {
          uc: 'NFR-3.4',
          action: `${run === 1 ? '【コールド】' : '【ウォーム】'}ログインして、ダッシュボードを表示する`,
          screen: 'ログイン（SC-01）→ ダッシュボード（SC-02）',
          limit,
        },
        steps,
      );
      await expect(page.getByRole('banner')).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

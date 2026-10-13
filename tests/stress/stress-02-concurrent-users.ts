/**
 * 負荷テスト（同時接続）: 大量データの状態で、複数の利用者（NFR-3.1 の「利用者10名ほど」。limits.ts の CONCURRENT_USERS）が、
 * 同時に、ダッシュボードの表示・観点の詳細・推移・一覧の表示と、データ入力の保存（評価の更新を伴う）・通知の既読を操作する。
 * 利用者ごとに別のブラウザのコンテキスト（別のセッション）を使い、全員が、同じ操作を同じタイミングで行う
 * （各操作の前で、全員がそろうのを待ってから、いっせいに操作する）。各操作の応答時間・次の操作が可能になるまでの時間を、記録する。
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { VIEWPOINTS } from '@smart-farm/shared/constants/viewpoints';
import { CONCURRENT_USERS, type LimitKey } from './support/limits.ts';
import { createObservedAtSource } from './support/observed-at.ts';
import { measure, trackApi, type ActionSteps } from './support/recorder.ts';
import { concurrentUserId } from './support/scale.ts';
import {
  expectDashboardShown,
  expectDetailShown,
  fillLogin,
  loadingView,
  mainArea,
  screenshot,
} from './support/ui.ts';

/** 全員がそろうのを待つ（そろったら、いっせいに進む）。 */
class Barrier {
  private waiting: (() => void)[] = [];
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  async arrive(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length === this.size) {
        const release = this.waiting;
        this.waiting = [];
        for (const item of release) {
          item();
        }
      }
    });
  }
}

const ROUNDS = 2;
const DETAIL_VIEWPOINTS = VIEWPOINTS.filter((viewpoint) => viewpoint.id !== 'satisfaction');

test(`同時接続: ${String(CONCURRENT_USERS)} 人が同時に、表示・入力・通知の操作を行う`, async ({
  browser,
}) => {
  const barrier = new Barrier(CONCURRENT_USERS);
  const sessions: { context: BrowserContext; page: Page; userId: string }[] = [];
  for (let index = 0; index < CONCURRENT_USERS; index += 1) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    const page = await context.newPage();
    trackApi(page);
    sessions.push({ context, page, userId: concurrentUserId(index) });
  }

  async function userFlow(index: number): Promise<void> {
    const session = sessions[index];
    if (session === undefined) {
      return;
    }
    const { page, userId } = session;
    /** 全員がそろってから、いっせいに操作して計測する。 */
    const m = async (
      uc: string,
      action: string,
      screen: string,
      limit: LimitKey,
      steps: ActionSteps,
    ): Promise<void> => {
      await barrier.arrive();
      await measure(page, { uc, action, screen, limit, user: userId, scenario: '同時接続' }, steps);
    };
    const menu = (name: string) =>
      page.getByRole('navigation', { name: 'メニュー' }).getByRole('link', { name, exact: true });
    const form = mainArea(page);
    // 手動入力の計測日時は、基準の時刻を固定して遡る（ラウンドの間隔が約1分でも、同じ分にならず、409 にならない）。利用者ごとに 30 分離す
    const nextObservedAt = createObservedAtSource(Date.now(), 120 + index * 30);

    await page.goto('/login');
    await fillLogin(page, userId);
    await m(
      'UC-13',
      'ログインする（全員が同時）',
      'ログイン（SC-01）→ ダッシュボード（SC-02）',
      'dashboardInitial',
      {
        act: () => page.getByRole('button', { name: 'ログイン' }).click(),
        respond: () => expectDashboardShown(page),
      },
    );
    if (index === 0) {
      await screenshot(page, '20-concurrent-dashboard');
    }

    for (let round = 0; round < ROUNDS; round += 1) {
      await m(
        'UC-01',
        'ダッシュボードを開く（画面の再読み込み。全員が同時）',
        'ダッシュボード（SC-02）',
        'dashboardInitial',
        {
          act: () => page.reload(),
          respond: () => expectDashboardShown(page),
        },
      );
      const equipment =
        round % 2 === 0 ? ['HOUSE-02', '負荷試験ハウス2'] : ['HOUSE-03', '負荷試験ハウス3'];
      await m(
        'UC-01',
        `対象の設備を${equipment[1] ?? ''}に切り替える（全員が同時）`,
        'ダッシュボード（SC-02）',
        'dashboardInitial',
        {
          act: () =>
            page
              .getByRole('banner')
              .getByLabel('対象の設備')
              .selectOption(equipment[0] ?? ''),
          respond: () => expectDashboardShown(page, equipment[1]),
        },
      );
      await m(
        'UC-01',
        '対象の設備をハウス1に戻す（全員が同時）',
        'ダッシュボード（SC-02）',
        'dashboardInitial',
        {
          act: () => page.getByRole('banner').getByLabel('対象の設備').selectOption('HOUSE-01'),
          respond: () => expectDashboardShown(page, '負荷試験ハウス1'),
        },
      );
      // 利用者ごとに、別の観点の詳細を開く
      const viewpoint = DETAIL_VIEWPOINTS[(index + round) % DETAIL_VIEWPOINTS.length];
      if (viewpoint !== undefined) {
        await m(
          'UC-02',
          `観点「${viewpoint.name}」の詳細を開く（全員が同時）`,
          '観点の詳細（SC-03）',
          'screen',
          {
            act: () =>
              page
                .getByTestId(`card-${viewpoint.id}`)
                .getByRole('heading')
                .getByRole('link')
                .click(),
            respond: () => expectDetailShown(page),
          },
        );
      }
      await m(
        'UC-03',
        '推移の期間を「直近30日」に切り替える（全員が同時）',
        '観点の詳細・推移（SC-03）',
        'trend',
        {
          act: () => page.getByLabel('長期の期間').selectOption({ label: '直近30日' }),
          respond: () => expectDetailShown(page),
        },
      );
      await m(
        'UC-03',
        '推移の期間を「直近90日」に切り替える（全員が同時）',
        '観点の詳細・推移（SC-03）',
        'trend',
        {
          act: () => page.getByLabel('長期の期間').selectOption({ label: '直近90日' }),
          respond: () => expectDetailShown(page),
        },
      );
      await m(
        'UC-20',
        '取り込み済みデータの一覧を開く（全員が同時。約60万件）',
        '取り込み済みデータ（SC-09）',
        'screen',
        {
          act: () => menu('取り込み済みデータ').click(),
          respond: async () => {
            await expect(loadingView(page)).toHaveCount(0);
            await expect(page.getByTestId('observation-row').first()).toBeVisible();
          },
        },
      );
      await m(
        'UC-20',
        '取り込み済みデータを、値の昇順に並べ替える（全員が同時）',
        '取り込み済みデータ（SC-09）',
        'screen',
        {
          act: async () => {
            await page.getByLabel('並べ替え', { exact: true }).selectOption('value');
            await page.getByLabel('並べ替えの向き').selectOption('asc');
          },
          respond: async () => {
            await expect(loadingView(page)).toHaveCount(0);
            await expect(page.getByTestId('observation-row').first()).toBeVisible();
          },
        },
      );
      // データ入力（全員が同時に保存。保存のたびに、評価を更新する）
      await m(
        'UC-06',
        'メニューから「データ入力」を開く（全員が同時）',
        'データ入力（SC-06）',
        'screen',
        {
          act: () => menu('データ入力').click(),
          respond: () => expect(form.getByLabel('対象の設備')).toBeVisible(),
        },
      );
      await form.getByLabel('対象の設備').selectOption('ROBOT-01');
      await form.getByLabel('カテゴリ').selectOption('FAILURE');
      await form.getByLabel('計測日時（日本時間）').fill(nextObservedAt());
      await form.getByTestId('entry-items').getByLabel('故障回数').fill('1');
      await form.getByTestId('entry-items').getByLabel('復旧に要した時間').fill('60');
      await m(
        'UC-06',
        '復旧対応の結果を入力して「保存する」を押す（全員が同時）',
        'データ入力（SC-06）',
        'operation',
        {
          act: () => form.getByRole('button', { name: '保存する' }).click(),
          respond: async () => {
            await expect(page.getByTestId('entry-result')).toContainText('保存しました');
            await expect(page.getByTestId('related-maintainability')).toBeVisible();
          },
        },
      );
      await m(
        'UC-22',
        'ヘッダーの未読件数から通知の一覧を開く（全員が同時）',
        '通知（SC-05）',
        'screen',
        {
          act: () => page.getByRole('link', { name: /^未読の通知/ }).click(),
          respond: async () => {
            await expect(loadingView(page)).toHaveCount(0);
            await expect(page.getByTestId('notification-row').first()).toBeVisible();
          },
        },
      );
      await m('UC-22', '通知を「既読にする」（全員が同時）', '通知（SC-05）', 'operation', {
        act: () =>
          page
            .getByTestId('notification-row')
            .and(page.locator('[data-read-state="UNREAD"]'))
            .first()
            .getByRole('button', { name: '既読にする' })
            .click(),
        respond: () => expect(page.getByTestId('notification-row').first()).toBeVisible(),
      });
      await m(
        'UC-01',
        'メニューから「ダッシュボード」を開く（全員が同時）',
        'ダッシュボード（SC-02）',
        'dashboardInitial',
        {
          act: () => menu('ダッシュボード').click(),
          respond: () => expectDashboardShown(page),
        },
      );
    }
    await m('UC-13', 'ログアウトする（全員が同時）', 'ログイン（SC-01）', 'screen', {
      act: () => page.getByRole('banner').getByRole('button', { name: 'ログアウト' }).click(),
      respond: () =>
        expect(page.getByRole('heading', { name: 'ログイン', level: 2 })).toBeVisible(),
    });
  }

  await Promise.all(sessions.map((_, index) => userFlow(index)));
  for (const session of sessions) {
    await session.context.close();
  }
});

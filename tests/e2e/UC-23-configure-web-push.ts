/**
 * UC-23 Web Push 通知を設定する（SC-15。FR-7.2）。
 *
 * ユースケースシナリオ（use-cases.md）:
 *   基本フロー  1. 農作業者が、Web Push 通知を有効にする
 *               2. 以降、UC-10・UC-24 の通知が、画面内の通知に加えて、Web Push で配信される
 *               3. 農作業者が、必要に応じて、通知を解除する
 *   代替フロー  通知を有効にしていない場合は、画面内の通知のみとする
 *   事後条件    Web Push 通知の有効・無効の状態が保存されている
 *
 * ブラウザの通知の許可と、Push サービスへの購読は、テストできないため、スタブにする（support/push.ts）。
 * サービスワーカーの登録、サーバーへの購読の登録・解除、配信の記録（Web Push のダミー）は、実際のものを使う。
 *
 * 値の同値分割: ブラウザの状態（未対応・許可なし（拒否済み）・未確認で許可する・未確認で拒否する・許可済み）、購読の状態
 * （無効・有効）、配信（成功・失敗して再送・購読が無効になる）、端末（複数）、利用者（ほかの利用者の購読とは独立）。
 * 関連するユースケース: UC-10（通知の発生）・UC-24（取り込み失敗の通知）・UC-22（画面内の通知）。
 */

import { expect, test, type Page } from '@playwright/test';
import {
  USER_B,
  addUser,
  advanceMinutes,
  alignBrowserClock,
  goToMenu,
  newUserSession,
  openAs,
  prepareApp,
  runJob,
  setMock,
} from './support/app.ts';
import {
  failIngestion,
  listNotifications,
  seedAbnormalEnvironment,
} from './support/notifications.ts';
import { deliveredPushes, pushStatus, stubPush, type PushStubOptions } from './support/push.ts';
import { shot } from './support/viewpoint-scenarios.ts';

/** Web Push の購読の宛先（スタブ）の、固定の部分。端末の識別（device）を、この後ろに付ける。 */
const ENDPOINT_PREFIX = 'https://push.example.invalid/e2e/';
/** 購読の宛先の長さの上限（API。PushSubscriptionRequestSchema）。 */
const ENDPOINT_MAX_LENGTH = 2000;

async function openPushSettings(page: Page, options: PushStubOptions = {}): Promise<void> {
  await stubPush(page, options);
  await alignBrowserClock(page);
  await openAs(page, '/');
  await goToMenu(page, '通知の設定');
  await expect(page.getByRole('heading', { name: '通知の設定', level: 1 })).toBeVisible();
}

const state = (page: Page) => page.getByTestId('push-state');
const enable = (page: Page) => page.getByRole('button', { name: '有効にする' });
const disable = (page: Page) => page.getByRole('button', { name: '解除する' });

test.describe('基本フロー: Web Push 通知を有効にし、以降の通知が配信され、解除すると配信されなくなる', () => {
  test('有効にすると、ブラウザの許可を求め、購読をサーバーへ登録し、状態が「有効」になる。再読み込みしても保持される', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await openPushSettings(page);
    await expect(state(page)).toContainText('無効');
    await expect(page.getByTestId('push-limitation')).toHaveCount(0);
    await shot(page, testInfo, 'uc23-disabled');

    // 1. 有効にする
    await enable(page).click();

    await expect(page.getByTestId('push-done')).toHaveText('Web Push 通知を有効にしました');
    await expect(state(page)).toContainText('有効');
    await expect(disable(page)).toBeVisible();
    expect((await pushStatus(request)).isSubscribed).toBe(true);
    // ブラウザの許可を求めた（初期の「未設定」が、回答の「許可」になる）
    expect(await page.evaluate(() => Notification.permission)).toBe('granted');
    await shot(page, testInfo, 'uc23-enabled');
    await page.reload();
    await expect(state(page)).toContainText('有効');
  });

  test('有効にした後に作られた通知（UC-10）は、画面内の通知に加えて、Web Push で配信される。解除すると、配信されない（UC-23 の基本フロー全体）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');

    // 2. 以降の通知: 異常（UC-10）と、取り込み失敗（UC-24）
    await seedAbnormalEnvironment(request);
    await failIngestion(request, ['robot']);
    await runJob(request, 'JB-04');

    const created = await listNotifications(request);
    expect(created.length).toBeGreaterThanOrEqual(4);
    const delivered = await deliveredPushes(request);
    expect(delivered.map((item) => item.notificationId).sort()).toEqual(
      created.map((item) => item.notificationId).sort(),
    );
    // 画面内の通知も、そのまま作られる
    await goToMenu(page, '通知');
    await expect(page.getByTestId('notification-row')).toHaveCount(created.length);

    // 3. 解除する → 以降の通知は、配信されない
    await goToMenu(page, '通知の設定');
    await disable(page).click();
    await expect(page.getByTestId('push-done')).toHaveText('Web Push 通知を解除しました');
    await expect(state(page)).toContainText('無効');
    await advanceMinutes(request, 61);
    await failIngestion(request, ['robot']);
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(delivered.length);
    expect(await listNotifications(request)).toHaveLength(created.length + 1);
  });

  test('代替フロー: 通知を有効にしていなければ、画面内の通知のみ（Web Push は配信されない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await seedAbnormalEnvironment(request);

    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(0);
    await alignBrowserClock(page);
    await openAs(page, '/notifications');
    await expect(page.getByTestId('notification-row').first()).toBeVisible();
  });

  test('解除したあと、もう一度有効にできる', async ({ page, request }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await disable(page).click();
    await expect(state(page)).toContainText('無効');

    await enable(page).click();

    await expect(state(page)).toContainText('有効');
    expect((await pushStatus(request)).isSubscribed).toBe(true);
  });
});

test.describe('ブラウザの状態の同値分割（未対応・許可なし・拒否・許可）', () => {
  test('Web Push に未対応のブラウザでは、その旨と、画面内の通知のみとなることを示し、有効にできない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);

    await openPushSettings(page, { supported: false });

    await expect(page.getByTestId('push-limitation')).toContainText(
      'このブラウザは、Web Push 通知に対応していません。画面内の通知のみ利用できます',
    );
    await expect(enable(page)).toBeDisabled();
    await expect(state(page)).toContainText('無効');
    await shot(page, testInfo, 'uc23-unsupported');
  });

  test('通知の許可が拒否されているブラウザでは、ブラウザの設定で許可するよう案内し、有効にできない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);

    await openPushSettings(page, { permission: 'denied' });

    await expect(page.getByTestId('push-limitation')).toContainText(
      'ブラウザで、通知が許可されていません。ブラウザの設定で許可すると、有効にできます。それまでは、画面内の通知のみです',
    );
    await expect(enable(page)).toBeDisabled();
  });

  test('許可を求められて拒否すると、有効にならず、許可されていない旨を示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page, { permission: 'default', answer: 'denied' });

    await enable(page).click();

    await expect(page.getByTestId('push-limitation')).toContainText(
      'ブラウザで、通知が許可されていません',
    );
    await expect(state(page)).toContainText('無効');
    expect((await pushStatus(request)).isSubscribed).toBe(false);
    await expect(page.getByTestId('push-done')).toHaveCount(0);
  });

  test('許可済みのブラウザでは、そのまま有効にできる', async ({ page, request }) => {
    await prepareApp(request);
    await openPushSettings(page, { permission: 'granted' });

    await enable(page).click();

    await expect(state(page)).toContainText('有効');
  });
});

test.describe('配信の失敗と再送（UC-10・UC-24 の通知の配信）', () => {
  test('Web Push の配信が失敗しても、画面内の通知は残り、復旧後の配信（再送）で届く', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await seedAbnormalEnvironment(request);
    const created = await listNotifications(request);

    await setMock(request, 'web-push', 'DOWN');
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(0);
    await setMock(request, 'web-push', 'UP');
    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(created.length);
    await goToMenu(page, '通知');
    await expect(page.getByTestId('notification-row')).toHaveCount(created.length);
  });

  test('配信の再送は、最大3回（初回を含む）まで。3回失敗した通知は、それ以降は再送されない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await seedAbnormalEnvironment(request);
    await setMock(request, 'web-push', 'DOWN');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runJob(request, 'JB-04');
    }

    await setMock(request, 'web-push', 'UP');
    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(0);
  });

  test('購読が無効になっている（ブラウザ側で解除・期限切れ）場合は、配信の結果から、購読を自動で破棄し、画面の状態は「無効」になる', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await seedAbnormalEnvironment(request);

    await setMock(request, 'web-push', 'REJECT');
    await runJob(request, 'JB-04');

    expect((await pushStatus(request)).isSubscribed).toBe(false);
    await page.reload();
    await expect(state(page)).toContainText('無効');
  });

  test('購読が自動で破棄された後も、もう一度有効にでき、以降の通知が配信される', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await seedAbnormalEnvironment(request);
    await setMock(request, 'web-push', 'REJECT');
    await runJob(request, 'JB-04');
    await page.reload();
    await expect(state(page)).toContainText('無効');
    await setMock(request, 'web-push', 'UP');

    await enable(page).click();

    await expect(state(page)).toContainText('有効');
    await advanceMinutes(request, 61);
    await failIngestion(request, ['robot']);
    await runJob(request, 'JB-04');
    const delivered = await deliveredPushes(request);
    expect(delivered).toHaveLength(1);
  });
});

test.describe('端末・利用者ごとの購読', () => {
  test('複数の端末で有効にすると、通知は、端末ごとに配信される', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await openPushSettings(page, { device: 'phone' });
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    const tablet = await newUserSession(browser, testInfo, 'tablet');
    await stubPush(tablet.page, { device: 'tablet' });
    await openAs(tablet.page, '/settings/push');
    await enable(tablet.page).click();
    await expect(state(tablet.page)).toContainText('有効');
    await seedAbnormalEnvironment(request);
    const created = await listNotifications(request);

    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(created.length * 2);
    await tablet.context.close();
  });

  test('利用者ごとに購読する（利用者Aが有効でも、利用者Bは無効のまま）。Bが有効にすると、A・B の両方に配信される', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    await prepareApp(request);
    await addUser(request, USER_B);
    await openPushSettings(page, { device: 'a-device' });
    await enable(page).click();
    await expect(state(page)).toContainText('有効');

    const b = await newUserSession(browser, testInfo, 'user-b');
    await stubPush(b.page, { device: 'b-device' });
    await openAs(b.page, '/settings/push', USER_B);
    await expect(state(b.page)).toContainText('無効');
    await enable(b.page).click();
    await expect(state(b.page)).toContainText('有効');

    await seedAbnormalEnvironment(request);
    const created = await listNotifications(request);
    await runJob(request, 'JB-04');
    expect(await deliveredPushes(request)).toHaveLength(created.length * 2);

    // Aが解除しても、Bの購読は残る
    await disable(page).click();
    await expect(state(page)).toContainText('無効');
    await b.page.reload();
    await expect(state(b.page)).toContainText('有効');
    await b.context.close();
  });
});

/**
 * SC-15 の枠（パネル）の中の、上から下への並び・左右の収まり・隙間を、機械的に確認する（画像の目視の補助）。
 * - 要素が、パネルの左右からはみ出さず、表示領域にも収まる
 * - 隣り合う要素が、重ならず、くっつかない（8px 以上）。離れすぎない（48px 以下）
 * - ボタンが、表示領域の中にあり、文字がボタンからあふれない
 */
async function expectPushPanelIntact(page: Page, label: string): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 0;
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const layout = await page.locator('.push-settings-page .panel').evaluate((panel) => {
    const rectOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    return {
      panel: rectOf(panel),
      children: [...panel.children]
        .map((element) => ({ name: element.className || element.tagName, ...rectOf(element) }))
        .filter((rect) => rect.bottom - rect.top > 0),
      buttons: [...panel.querySelectorAll('button')].map((button) => ({
        ...rectOf(button),
        clipped: button.scrollWidth > button.clientWidth + 1,
      })),
    };
  });
  const { panel, children, buttons } = layout;
  expect(panel.left, `${label}: 枠の左端`).toBeGreaterThanOrEqual(0);
  expect(panel.right, `${label}: 枠の右端`).toBeLessThanOrEqual(viewportWidth);
  for (const [index, child] of children.entries()) {
    expect(child.left, `${label}: ${child.name} の左端`).toBeGreaterThanOrEqual(panel.left);
    expect(child.right, `${label}: ${child.name} の右端`).toBeLessThanOrEqual(panel.right + 0.5);
    const next = children[index + 1];
    if (next !== undefined) {
      const gap = next.top - child.bottom;
      expect(gap, `${label}: ${child.name} と ${next.name} の隙間`).toBeGreaterThanOrEqual(8);
      expect(gap, `${label}: ${child.name} と ${next.name} の隙間`).toBeLessThanOrEqual(48);
    }
  }
  // ボタンは、枠の中にあり、文字があふれず、画面をスクロールしなくても届く
  for (const button of buttons) {
    expect(button.left, `${label}: ボタンの左端`).toBeGreaterThanOrEqual(panel.left);
    expect(button.right, `${label}: ボタンの右端`).toBeLessThanOrEqual(panel.right);
    expect(button.clipped, `${label}: ボタンの文字`).toBe(false);
    expect(button.bottom, `${label}: ボタンの下端`).toBeLessThanOrEqual(viewportHeight);
  }
}

const PUSH_VIEWPORTS = [
  { name: 'デスクトップ幅（1280px）', width: 1280, height: 720 },
  { name: 'タブレット幅（768px。NFR-7.3）', width: 768, height: 1024 },
  { name: 'スマートフォン幅（375px）', width: 375, height: 667 },
] as const;

for (const viewport of PUSH_VIEWPORTS) {
  test.describe(`${viewport.name}: 通知の設定（SC-15）の各状態でも、はみ出し・隙間の詰まりがなく、操作ボタンに届く`, () => {
    const tag = String(viewport.width);

    async function open(page: Page, options: PushStubOptions = {}): Promise<void> {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await stubPush(page, options);
      await alignBrowserClock(page);
      await openAs(page, '/settings/push');
      await expect(page.getByRole('heading', { name: '通知の設定', level: 1 })).toBeVisible();
      await expect(state(page)).toBeVisible();
    }

    test('無効 → 有効（完了の表示）→ 解除（完了の表示）', async ({ page, request }, testInfo) => {
      await prepareApp(request);
      await open(page);
      await expectPushPanelIntact(page, '無効');
      await shot(page, testInfo, `uc23-${tag}-disabled`);

      await enable(page).click();
      await expect(page.getByTestId('push-done')).toBeVisible();
      await expectPushPanelIntact(page, '有効');
      await shot(page, testInfo, `uc23-${tag}-enabled`);

      await disable(page).click();
      await expect(page.getByTestId('push-done')).toHaveText('Web Push 通知を解除しました');
      await expectPushPanelIntact(page, '解除後');
      await shot(page, testInfo, `uc23-${tag}-disabled-again`);
    });

    test('未対応のブラウザの案内', async ({ page, request }, testInfo) => {
      await prepareApp(request);
      await open(page, { supported: false });
      await expect(page.getByTestId('push-limitation')).toContainText('対応していません');
      await expectPushPanelIntact(page, '未対応');
      await shot(page, testInfo, `uc23-${tag}-unsupported`);
    });

    test('許可されていないブラウザの案内（長い文）', async ({ page, request }, testInfo) => {
      await prepareApp(request);
      await open(page, { permission: 'denied' });
      await expect(page.getByTestId('push-limitation')).toContainText('許可されていません');
      await expectPushPanelIntact(page, '許可されていない');
      await shot(page, testInfo, `uc23-${tag}-denied`);
    });

    test('購読の宛先が、上限（2000文字）の端末でも有効にできる。上限を超えると、エラーを示し、無効のまま', async ({
      page,
      request,
    }, testInfo) => {
      await prepareApp(request);
      await open(page, { device: 'a'.repeat(ENDPOINT_MAX_LENGTH - ENDPOINT_PREFIX.length) });
      await enable(page).click();
      await expect(page.getByTestId('push-done')).toBeVisible();
      await expect(state(page)).toContainText('有効');
      expect((await pushStatus(request)).isSubscribed).toBe(true);
      await expectPushPanelIntact(page, '宛先が上限');
      await shot(page, testInfo, `uc23-${tag}-endpoint-max`);
      await disable(page).click();
      await expect(state(page)).toContainText('無効');

      const tooLong = 'b'.repeat(ENDPOINT_MAX_LENGTH - ENDPOINT_PREFIX.length + 1);
      await stubPush(page, { device: tooLong });
      await page.reload();
      await expect(state(page)).toContainText('無効');
      await enable(page).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(state(page)).toContainText('無効');
      await expect(page.getByTestId('push-done')).toHaveCount(0);
      await expectPushPanelIntact(page, '宛先が上限超過');
      await shot(page, testInfo, `uc23-${tag}-endpoint-too-long`);
    });
  });
}

test.describe('宛先が上限（2000文字）の購読への配信', () => {
  test('配信され、解除すると、購読が消える', async ({ page, request }) => {
    await prepareApp(request);
    await openPushSettings(page, {
      device: 'c'.repeat(ENDPOINT_MAX_LENGTH - ENDPOINT_PREFIX.length),
    });
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
    await seedAbnormalEnvironment(request);
    const created = await listNotifications(request);

    await runJob(request, 'JB-04');

    expect(await deliveredPushes(request)).toHaveLength(created.length);
    await disable(page).click();
    await expect(state(page)).toContainText('無効');
    expect((await pushStatus(request)).isSubscribed).toBe(false);
  });
});

/**
 * サービスワーカー（src/frontend/public/sw.js）の確認。アプリが登録した、実際のサービスワーカー（ブラウザ上）に、
 * push・notificationclick のイベントを渡し、受け取った内容から、通知の表示（showNotification の引数）と、通知を選んだときの
 * 動作（通知を閉じる・/notifications を開く）が正しいことを確認する。
 *
 * 確認できないこと（E2E の限界）: Push サービスからの実際の配信、OS・ブラウザの通知の表示。テストのブラウザ（ヘッドレスの
 * Chromium）は、サービスワーカーからの通知の表示を許可しないため、showNotification・openWindow は、記録する関数に差し替えて確認する。
 */
interface RecordedCalls {
  shown: { title: string; options: { body?: string; tag?: string } }[];
  opened: string[];
  closed: number;
}

interface WorkerScope {
  registration: {
    showNotification(title: string, options: { body?: string; tag?: string }): Promise<void>;
  };
  clients: { openWindow(url: string): Promise<unknown> };
  dispatchEvent(event: Event): boolean;
}

/** サービスワーカーの中で、イベントを発生させ、記録された呼び出しを返す。 */
async function dispatchToWorker(
  page: Page,
  event: { type: 'push'; json: unknown } | { type: 'notificationclick' },
): Promise<RecordedCalls> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const worker = page.context().serviceWorkers()[0];
  if (worker === undefined) {
    throw new Error('サービスワーカーが登録されていません');
  }
  return worker.evaluate(async (input) => {
    const scope = self as unknown as WorkerScope;
    const calls: RecordedCalls = { shown: [], opened: [], closed: 0 };
    scope.registration.showNotification = (title, options) => {
      calls.shown.push({ title, options });
      return Promise.resolve();
    };
    scope.clients.openWindow = (url) => {
      calls.opened.push(url);
      return Promise.resolve(undefined);
    };
    const dispatched = new (
      globalThis as unknown as { ExtendableEvent: new (type: string) => Event }
    ).ExtendableEvent(input.type) as Event & {
      waitUntil(promise: Promise<unknown>): void;
    };
    const pending: Promise<unknown>[] = [];
    Object.defineProperty(dispatched, 'waitUntil', {
      value: (promise: Promise<unknown>) => pending.push(promise),
    });
    if (input.type === 'push') {
      // データのない push は、event.data が null
      Object.defineProperty(dispatched, 'data', {
        value: input.json === undefined ? null : { json: () => input.json },
      });
    } else {
      Object.defineProperty(dispatched, 'notification', {
        value: {
          close: () => {
            calls.closed += 1;
          },
        },
      });
    }
    scope.dispatchEvent(dispatched);
    await Promise.all(pending);
    return calls;
  }, event);
}

test.describe('サービスワーカー（public/sw.js）: 受信した push を通知として表示し、選ぶと通知の画面を開く', () => {
  test.beforeEach(async ({ page, request }) => {
    await prepareApp(request);
    await openPushSettings(page);
    await enable(page).click();
    await expect(state(page)).toContainText('有効');
  });

  test('push を受け取ると、内容（タイトル・本文・識別子）の通知を表示する', async ({ page }) => {
    const calls = await dispatchToWorker(page, {
      type: 'push',
      json: {
        title: '異常を検知しました（環境適応性）',
        message: 'ハウス1の温度が基準を超えています',
        notificationId: 'dummy-notification-1',
      },
    });

    expect(calls.shown).toEqual([
      {
        title: '異常を検知しました（環境適応性）',
        options: { body: 'ハウス1の温度が基準を超えています', tag: 'dummy-notification-1' },
      },
    ]);
    expect(calls.opened).toEqual([]);
  });

  test('内容のない push は、既定のタイトル・本文の通知を表示する', async ({ page }) => {
    const calls = await dispatchToWorker(page, { type: 'push', json: undefined });

    expect(calls.shown).toEqual([
      { title: '稼働モニタリング', options: { body: '新しい通知があります' } },
    ]);
  });

  test('通知を選ぶと、通知を閉じ、通知の画面（/notifications）を開く', async ({ page }) => {
    const calls = await dispatchToWorker(page, { type: 'notificationclick' });

    expect(calls.closed).toBe(1);
    expect(calls.opened).toEqual(['/notifications']);
    expect(calls.shown).toEqual([]);
  });
});

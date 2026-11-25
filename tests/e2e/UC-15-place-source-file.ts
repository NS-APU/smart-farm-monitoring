/**
 * UC-15 ブラウザから、設備ごとの取り込み用のファイルを置く（SC-11 の「ファイルを置く」。Issue #565。ADR-0027。FR-1.3、NFR-5.4、NFR-7.3）。
 *
 * ユースケースシナリオ（use-cases.md の UC-15。取り込み元のファイルを、設備ごとに用意する流れ）:
 *   基本フロー  1. 管理者が、設備（ロボット・環境センサー）のファイルのパスを設定する（SC-10 設備のダイアログ）
 *               2. 管理者が、取り込み（SC-11）の設備の行で「ファイルを置く」を開き、ファイルを選ぶ
 *               3. 管理者が、「内容を確認」で、置けるか（仕様の版・計測日時・項目数・置けない理由・警告）を確かめる
 *               4. 管理者が、「置く」→ 確認のダイアログ（同じパスのファイルは置き換わる）で確定する
 *               5. システムが、ファイルを設備のファイルのパスに置き、結果を通知する（自動では、取り込まない。「今すぐ取り込む」で、即時取得へ進める）
 *   代替フロー  置けない内容（JSON でない・形式が仕様と違う・計測日時がない）は、理由を示し、「置く」を使えない
 *               1 MiB を超えるファイルは、送信せず、その場で、エラーを示す
 *   事後条件    設備のファイルのパスの場所に、ファイルが置かれている（取り込み〔UC-08・UC-09〕が読む）
 *
 * 値の同値分割: 権限（管理者・閲覧者〔参照のみ〕・一般〔取り込みの設定を見ない〕）、設備（ファイルのパスあり・なし）、ファイルの内容（置ける・置けない〔形式違い〕）、
 * ファイルの大きさ（上限以下・上限超え）、画面の幅（広い・375px）、確認のダイアログ（確定・キャンセル）。
 * 保管先は、メモリ（ローカル・E2E のバックエンド）。置いた内容が取り込みまで届く流れ（HTTP のファイルサーバー経由）は、別のテストで確かめる。
 * 関連するユースケース: UC-12（設備のファイルのパス）、UC-08・UC-09（置いたファイルの取り込み）、UC-15（接続の設定・即時取得）。
 */

import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  GENERAL,
  ROBOT_ID,
  SENSOR_ID,
  VIEWER,
  addUser,
  alignBrowserClock,
  goToMenu,
  openAs,
  prepareApp,
} from './support/app.ts';
import { assignFilePath } from './support/http-files.ts';
import { equipmentRow, sourceCard } from './support/ingestion.ts';
import { shot } from './support/viewpoint-scenarios.ts';

const ROBOT_FILE_PATH = '/robot/robot-01.json';
const SENSOR_FILE_PATH = '/environment-sensor/sensor-01.json';
/** 置ける内容（ロボットの定義に沿った、合成データ。項目 7 つ）と、置けない内容（形式が壊れた合成データ）。 */
const VALID_FILE = resolve('tests/fixtures/file-server/robot/robot-definition-sample-001.json');
/** 環境センサーの定義に沿った、合成データ（項目 4 つ）。 */
const SENSOR_VALID_FILE = resolve(
  'tests/fixtures/file-server/environment-sensor/sensor-definition-sample-001.json',
);
const BROKEN_FILE = resolve('tests/fixtures/file-server/robot/robot-sample-003-broken.json');
/** 上限（1 MiB）を超える大きさ（合成データ。中身は、空白だけ）。 */
const OVER_LIMIT = { name: 'too-big.json', mimeType: 'application/json', size: 1024 * 1024 + 1 };

async function openIngestion(page: Page, user?: Parameters<typeof openAs>[2]): Promise<void> {
  await alignBrowserClock(page);
  await openAs(page, '/', user);
  await goToMenu(page, '取り込み');
  await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
}

const placeButton = (page: Page, equipmentId: string) =>
  page.getByTestId(`equipment-place-${equipmentId}`);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'ファイルを置く' });
const fileInput = (page: Page) => dialog(page).getByLabel(/取り込み用のファイル/);
const checkButton = (page: Page) => dialog(page).getByRole('button', { name: '内容を確認' });
const putButton = (page: Page) =>
  dialog(page).getByRole('button', { name: '置く', exact: true }).first();
const inspection = (page: Page) => page.getByTestId('source-file-inspection');

/** 設備の「ファイルを置く」を開き、ファイルを選んで、内容を確認する。 */
async function chooseAndCheck(page: Page, equipmentId: string, filePath: string): Promise<void> {
  await placeButton(page, equipmentId).click();
  await expect(dialog(page)).toBeVisible();
  await fileInput(page).setInputFiles(filePath);
  await expect(page.getByTestId('source-file-selected')).toBeVisible();
  await checkButton(page).click();
  await expect(inspection(page)).toBeVisible();
}

test.describe('基本フロー: 設備のファイルのパスを設定し、ブラウザからファイルを置く', () => {
  test('SC-10 で、ロボットのファイルのパスを設定する → SC-11 の「ファイルを置く」でファイルを選ぶ → 内容を確認（項目数など）→ 置く → 確認のダイアログ → 成功の通知。自動では取り込まず、「今すぐ取り込む」を出す', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await alignBrowserClock(page);

    // 1. 設備のファイルのパスを設定する（SC-10。設備のダイアログ）。パスのない設備には、SC-11 に、ボタンを出さない
    await openAs(page, `/settings/equipment?edit=${ROBOT_ID}`);
    const edit = page.getByTestId('equipment-edit');
    await expect(edit).toBeVisible();
    await edit.getByLabel('ファイルパス').fill(ROBOT_FILE_PATH);
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByTestId('equipment-notice')).toHaveText('修正しました');

    await goToMenu(page, '取り込み');
    await expect(page.getByRole('heading', { name: '取り込み', level: 1 })).toBeVisible();
    await expect(equipmentRow(page, ROBOT_ID)).toBeVisible();
    await expect(placeButton(page, ROBOT_ID)).toHaveText('ファイルを置く');
    // ファイルのパスのない設備（環境センサー）には、出さない
    await expect(equipmentRow(page, SENSOR_ID)).toBeVisible();
    await expect(placeButton(page, SENSOR_ID)).toHaveCount(0);

    // 2. ファイルを選ぶ
    await placeButton(page, ROBOT_ID).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByTestId('source-file-target')).toContainText('収穫ロボット1');
    await expect(page.getByTestId('source-file-target')).toContainText(ROBOT_FILE_PATH);
    // 選ぶまでは、確認も置くも使えない
    await expect(checkButton(page)).toBeDisabled();
    await expect(putButton(page)).toBeDisabled();
    await fileInput(page).setInputFiles(VALID_FILE);
    await expect(page.getByTestId('source-file-selected')).toContainText(
      'robot-definition-sample-001.json',
    );
    // 確認するまでは、置けない
    await expect(putButton(page)).toBeDisabled();

    // 3. 内容を確認する（置く前の検査。保存しない）
    await checkButton(page).click();
    await expect(page.getByTestId('source-file-inspection-status')).toHaveText('置けます');
    await expect(page.getByTestId('source-file-format')).toHaveText('robot-json@1.0.0(CONFIRMED)');
    // 2026-10-09T02:00:00Z = 日本時間 11:00:00
    await expect(page.getByTestId('source-file-observed-at')).toHaveText('2026/10/09 11:00:00');
    await expect(page.getByTestId('source-file-item-count')).toHaveText('7 件');
    await expect(page.getByTestId('source-file-problems')).toHaveCount(0);
    await expect(putButton(page)).toBeEnabled();
    await shot(page, testInfo, 'uc15-place-checked');

    // 4. 置く → 確認のダイアログ（キャンセルでは、置かない。フォームは残る）
    await putButton(page).click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('同じパスのファイルは、置き換わります');
    await expect(confirm).toContainText('収穫ロボット1');
    await expect(confirm).toContainText('robot-definition-sample-001.json');
    await expect(confirm).toContainText('2026/10/09 11:00:00');
    await shot(page, testInfo, 'uc15-place-confirm');
    await confirm.getByRole('button', { name: 'キャンセル' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog(page)).toBeVisible();
    await expect(inspection(page)).toBeVisible();

    await putButton(page).click();
    await confirm.getByRole('button', { name: '置く', exact: true }).click();

    // 5. 成功の通知。ダイアログは閉じ、自動では、取り込まない（取り込みのログは、増えない）
    await expect(dialog(page)).toBeHidden();
    const result = page.getByTestId('source-file-result-robot');
    await expect(result).toHaveText(
      'ファイルを置きました: 収穫ロボット1（計測日時 2026/10/09 11:00:00）',
    );
    await expect(result).toHaveClass(/form-success/);
    await expect(result).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('source-file-placed-robot')).toContainText(
      '取り込みは、まだ行っていません',
    );
    await expect(
      page.getByTestId('source-file-placed-robot').getByRole('button', { name: '今すぐ取り込む' }),
    ).toBeVisible();
    await expect(page.getByTestId('ingestion-logs-empty')).toBeVisible();
    await shot(page, testInfo, 'uc15-place-done');
  });

  test('環境センサーの設備でも、同じように置ける（ファイルのパスのある設備）。対象の設備と、その設備のファイルのパスを示す', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await assignFilePath(request, SENSOR_ID, SENSOR_FILE_PATH);
    await openIngestion(page);

    await chooseAndCheck(page, SENSOR_ID, SENSOR_VALID_FILE);
    await expect(page.getByTestId('source-file-target')).toContainText('環境センサー1');
    await expect(page.getByTestId('source-file-target')).toContainText(SENSOR_FILE_PATH);
    await expect(page.getByTestId('source-file-format')).toHaveText(
      'environment-sensor-json@1.0.0(CONFIRMED)',
    );
    await expect(page.getByTestId('source-file-item-count')).toHaveText('4 件');
    await putButton(page).click();
    await page
      .getByTestId('confirm-dialog')
      .getByRole('button', { name: '置く', exact: true })
      .click();

    await expect(page.getByTestId('source-file-result-environment-sensor')).toContainText(
      'ファイルを置きました: 環境センサー1',
    );
    await expect(sourceCard(page, 'environment-sensor')).toBeVisible();
  });
});

test.describe('代替フロー: 置けない内容・大きすぎるファイル', () => {
  test('置けない内容は、「置く」が無効になり、置けない理由を示す。ダイアログは閉じず、別のファイルを選び直せる', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await openIngestion(page);
    const puts: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'PUT' && sent.url().includes('/source-file')) {
        puts.push(sent.url());
      }
    });

    await chooseAndCheck(page, ROBOT_ID, BROKEN_FILE);

    const status = page.getByTestId('source-file-inspection-status');
    await expect(status).toHaveText('置けません');
    await expect(status).toHaveClass(/form-error/);
    const problems = page.getByTestId('source-file-problems');
    await expect(problems.getByRole('heading', { name: '置けない理由' })).toBeVisible();
    expect(await problems.getByRole('listitem').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('source-file-observed-at')).toHaveText('読み取れませんでした');
    await expect(putButton(page)).toBeDisabled();
    await shot(page, testInfo, 'uc15-place-problems');

    // 別のファイル（置ける内容）を選び直すと、確認の結果を消し、確認し直して、置けるようになる
    await fileInput(page).setInputFiles(VALID_FILE);
    await expect(inspection(page)).toHaveCount(0);
    await expect(putButton(page)).toBeDisabled();
    await checkButton(page).click();
    await expect(page.getByTestId('source-file-inspection-status')).toHaveText('置けます');
    await expect(putButton(page)).toBeEnabled();
    expect(puts).toEqual([]);
  });

  test('1 MiB を超えるファイルは、送信せず、その場で、エラーを示す（確認も置くも使えない）', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await openIngestion(page);
    const sourceFileRequests: string[] = [];
    page.on('request', (sent) => {
      if (sent.url().includes('/source-file')) {
        sourceFileRequests.push(`${sent.method()} ${sent.url()}`);
      }
    });
    await placeButton(page, ROBOT_ID).click();
    await expect(dialog(page)).toBeVisible();

    await fileInput(page).setInputFiles({
      name: OVER_LIMIT.name,
      mimeType: OVER_LIMIT.mimeType,
      buffer: Buffer.alloc(OVER_LIMIT.size, ' '),
    });

    await expect(dialog(page)).toContainText('1 MiB を超えるファイルは、置けません');
    await expect(fileInput(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('source-file-selected')).toHaveCount(0);
    await expect(checkButton(page)).toBeDisabled();
    await expect(putButton(page)).toBeDisabled();
    expect(sourceFileRequests).toEqual([]);
  });

  test('Esc で、ダイアログを閉じ、フォーカスを、開いたボタンへ戻す', async ({ page, request }) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await openIngestion(page);

    await placeButton(page, ROBOT_ID).click();
    await expect(dialog(page)).toBeVisible();
    await expect(fileInput(page)).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(dialog(page)).toBeHidden();
    await expect(placeButton(page, ROBOT_ID)).toBeFocused();
  });
});

test.describe('権限: 取り込みを設定する権限（管理者）だけ', () => {
  test('閲覧者（参照のみ）には、「ファイルを置く」を出さない（設備ごとの表は、参照できる）。サーバー側でも、拒否する', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await addUser(request, VIEWER);

    await openIngestion(page, VIEWER);

    await expect(equipmentRow(page, ROBOT_ID)).toBeVisible();
    await expect(page.getByRole('button', { name: /のファイルを置く$/ })).toHaveCount(0);
    const login = await request.post('/api/v1/auth/login', {
      data: { userId: VIEWER.userId, password: VIEWER.password },
    });
    const { accessToken } = (await login.json()) as { accessToken: string };
    for (const [method, path] of [
      ['POST', `/ingestion/equipment/${ROBOT_ID}/source-file/check`],
      ['PUT', `/ingestion/equipment/${ROBOT_ID}/source-file`],
    ] as const) {
      const refused = await request.fetch(`/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        data: '{}',
      });
      expect(refused.status()).toBe(403);
    }
  });

  test('一般ユーザーには、取り込みの設定（設備ごとの表）がなく、「ファイルを置く」も出ない', async ({
    page,
    request,
  }) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await addUser(request, GENERAL);

    await openIngestion(page, GENERAL);

    await expect(page.getByRole('button', { name: /ファイルを置く/ })).toHaveCount(0);
    await expect(page.getByTestId(`equipment-run-${ROBOT_ID}`)).toHaveCount(0);
  });
});

test.describe('スマートフォン幅（375px。NFR-7.3）', () => {
  test('設備の行・ダイアログ（確認の結果を含む）・確認のダイアログ・結果の通知が、画面の幅に収まり、横にスクロールしない', async ({
    page,
    request,
  }, testInfo) => {
    await prepareApp(request);
    await assignFilePath(request, ROBOT_ID, ROBOT_FILE_PATH);
    await page.setViewportSize({ width: 375, height: 800 });
    await openIngestion(page);
    await expect(placeButton(page, ROBOT_ID)).toBeVisible();
    await shot(page, testInfo, 'uc15-place-375-table');

    await chooseAndCheck(page, ROBOT_ID, VALID_FILE);
    const fitsInViewport = async (testId: string): Promise<void> => {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    };
    await fitsInViewport('source-file-dialog');
    await fitsInViewport('source-file-inspection');
    await shot(page, testInfo, 'uc15-place-375-dialog');

    await putButton(page).click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await fitsInViewport('confirm-dialog');
    await shot(page, testInfo, 'uc15-place-375-confirm');
    await page
      .getByTestId('confirm-dialog')
      .getByRole('button', { name: '置く', exact: true })
      .click();

    await expect(page.getByTestId('source-file-result-robot')).toBeVisible();
    await expect(page.getByTestId('source-file-result-robot')).toBeInViewport();
    await shot(page, testInfo, 'uc15-place-375-done');
  });
});

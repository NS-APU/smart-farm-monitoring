/**
 * ヘルプヒント・凡例を置いた画面（ダッシュボード SC-02・観点の詳細 SC-03・計測データ SC-09・データ入力 SC-06。Issue #154 の PR2）の単体テスト。
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { card, dashboard, jsonResponse } from '../../support/frontend.ts';
import { renderApp } from '../../support/management-frontend.ts';
import { detail, observationList, series } from '../../support/viewpoint-fixtures.ts';

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

const hint = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('ダッシュボード（SC-02-7）: 指標名のヘルプヒント', () => {
  const routes = {
    'GET /dashboard': () =>
      jsonResponse(
        dashboard({
          viewpoints: [
            card({
              viewpointId: 'harvestSpeed',
              name: '収穫速度',
              metrics: { averageSecondsPerFruit: 50, travelStoppedRatePercent: 2 },
              metricStatuses: {},
              statusDetail: { code: 'HARVESTING', name: '収穫中', category: 'NORMAL' },
            }),
            card({
              viewpointId: 'durability',
              name: '耐久性',
              metrics: { mtbfHours: 300 },
              metricStatuses: {},
            }),
          ],
        }),
      ),
  };

  it('走行停止率・MTBF・ステータスなどの指標名の横に、説明を開くボタンがある。押すと、設計の定義にもとづく説明が出る', async () => {
    renderApp('/', routes);
    await screen.findByTestId('card-harvestSpeed');

    const stopped = hint('走行停止率の説明');
    expect(stopped.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(stopped);

    expect(screen.getByRole('note').textContent).toContain('走行が止まっていた時間の割合');
    expect(screen.getByRole('button', { name: '平均故障間隔（MTBF）の説明' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ステータスの説明' })).toBeDefined();
    expect(screen.getByRole('button', { name: '平均処理時間の説明' })).toBeDefined();
  });

  it('指標名（dt）のテキストは、これまでどおり（説明のボタンは、名前に影響しない）', async () => {
    renderApp('/', routes);
    const speed = await screen.findByTestId('card-harvestSpeed');

    const names = Array.from(speed.querySelectorAll('dt')).map(
      (term) => term.firstChild?.textContent,
    );
    expect(names).toEqual(['平均処理時間', '走行停止率', 'ステータス']);
  });

  it('定義のない指標（温度など）には、説明のボタンを付けない', async () => {
    renderApp('/', {
      'GET /dashboard': () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card({
                viewpointId: 'environmentalAdaptability',
                name: '環境適応性',
                metrics: { temperatureCelsius: 22 },
                metricStatuses: {},
              }),
            ],
          }),
        ),
    });
    const environment = await screen.findByTestId('card-environmentalAdaptability');

    expect(within(environment).queryByRole('button')).toBeNull();
  });
});

describe('ダッシュボード（SC-02-7）: 状態の凡例', () => {
  it('「状態の見かた」を開くと、正常・注意・異常・不明の意味を示す。はじめは閉じている', async () => {
    renderApp('/', { 'GET /dashboard': () => jsonResponse(dashboard()) });
    await screen.findByTestId('card-safety');
    const toggle = screen.getByRole('button', { name: '状態の見かた' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('status-legend-body')).toBeNull();

    fireEvent.click(toggle);

    const body = screen.getByTestId('status-legend-body');
    expect(within(body).getByTestId('status-legend-NORMAL').textContent).toContain(
      '判断基準を満たしています',
    );
    expect(within(body).getByTestId('status-legend-UNKNOWN').textContent).toContain(
      '評価に必要なデータが足りず、評価できません',
    );
  });
});

describe('観点の詳細（SC-03）: 根拠の指標のヘルプヒント', () => {
  it('指標名の横に、説明のボタンがある。主要の印（tag）は、これまでどおり出る', async () => {
    renderApp('/viewpoints/harvestSpeed', {
      'GET /viewpoints/harvestSpeed': () =>
        jsonResponse(
          detail({
            viewpointId: 'harvestSpeed',
            name: '収穫速度',
            metrics: [
              {
                metricId: 'travelStoppedRatePercent',
                value: 2,
                indicatorStatus: 'NORMAL',
                isPrimary: true,
              },
            ],
          }),
        ),
      'GET /viewpoints/harvestSpeed/series': () => jsonResponse(series()),
      'GET /observations': () => jsonResponse(observationList()),
    });
    const row = await screen.findByTestId('metric-travelStoppedRatePercent');

    fireEvent.click(within(row).getByRole('button', { name: '走行停止率の説明' }));

    expect(screen.getByRole('note').textContent).toContain('走行が止まっていた時間の割合');
    expect(row.textContent).toContain('主要');
  });
});

describe('計測データ（SC-09-2）: データの状態の凡例', () => {
  it('「データの状態の見かた」を開くと、有効・欠損・遅延・不正の意味と、評価での扱いを示す', async () => {
    renderApp('/observations', {
      'GET /observations/measurements': () => jsonResponse({ items: [], nextCursor: null }),
    });
    const toggle = await screen.findByRole('button', { name: 'データの状態の見かた' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    const body = screen.getByTestId('quality-legend-body');
    expect(within(body).getByTestId('quality-legend-MISSING').textContent).toContain(
      '評価に使いません',
    );
    expect(within(body).getByTestId('quality-legend-LATE').textContent).toContain('評価に使います');
  });
});

describe('データ入力（SC-06-9）: 入力欄のヘルプヒント', () => {
  /** ロボット（ROBOT-01）を対象に、カテゴリを選んで、入力のフォームを開く。 */
  async function openForm(category: string): Promise<void> {
    renderApp('/data-entry');
    await screen.findByRole('button', { name: '保存する' });
    const form = document.querySelector<HTMLElement>('form.entry-form');
    if (form === null) {
      throw new Error('入力のフォームがありません');
    }
    fireEvent.change(within(form).getByLabelText('対象の設備', { exact: false }), {
      target: { value: 'ROBOT-01' },
    });
    fireEvent.change(within(form).getByLabelText('カテゴリ', { exact: false }), {
      target: { value: category },
    });
  }

  it('カテゴリ・計測日時・備考にも、説明のボタンがある。カテゴリは、選べるカテゴリの意味（データ辞書）を並べる', async () => {
    await openForm('SAFETY');

    fireEvent.click(hint('カテゴリの説明'));

    const text = screen.getByRole('note').textContent;
    expect(text).toContain('安全情報');
    expect(text).toContain('緊急停止・ヒヤリハット');
    expect(hint('計測日時（日本時間）の説明')).toBeDefined();
    expect(hint('備考（所感・補足情報）の説明')).toBeDefined();
  });

  it('安全情報: ヒヤリハット件数・緊急停止回数に、意味のヒントがある。ラベルで入力欄を探す操作に、ヒントのボタンが混ざらない', async () => {
    await openForm('SAFETY');

    fireEvent.click(hint('ヒヤリハット件数（件）の説明'));

    expect(screen.getByRole('note').textContent).toContain('緊急停止を伴う出来事');
    expect(hint('緊急停止回数（回）の説明')).toBeDefined();
    expect(screen.getAllByLabelText('ヒヤリハット件数（件）')).toHaveLength(1);
  });

  it('1 果実あたりの収穫時間: 意味と入力例を示す', async () => {
    await openForm('HARVEST');

    fireEvent.click(hint('1果実あたりの収穫時間（秒/果実）の説明'));

    const text = screen.getByRole('note').textContent;
    expect(text).toContain('1果実の収穫にかかった時間');
    expect(text).toContain('例: 45');
  });

  it.each(['COST', 'FAILURE', 'OPERABILITY'])(
    'D-20（コスト）・D-21（故障）・D-22（操作）の項目（%s）には、ヒントを付けない（別の Issue で行う）',
    async (category) => {
      await openForm(category);

      const items = screen.getByTestId('entry-items');

      expect(within(items).queryAllByRole('button')).toHaveLength(0);
    },
  );
});

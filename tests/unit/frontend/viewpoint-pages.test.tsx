/**
 * ダッシュボードの操作（対象のハウス・期間・更新）・表示（取得日時・対象期間・状態の表・カード。UC-01・UC-04。Issue #355・#356）、観点の詳細（UC-02・UC-03・UC-04。SC-03）、
 * 満足度の詳細（UC-21。SC-04）の画面の単体テスト。API はスタブ（tests/support）。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { UNKNOWN_ACTION } from '@smart-farm/shared/constants/status';
import type { SeriesResponse } from '@smart-farm/shared/schemas/evaluation';
import { App } from '../../../src/frontend/app.tsx';
import {
  WORKER_LOGIN,
  card,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  twoFacilityTree,
  errorResponse,
  jsonResponse,
  type FakeHandler,
  type FakeRequest,
} from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';
import {
  detail,
  diagnosis,
  observationList,
  satisfactionDetail,
  series,
  speedDetail,
} from '../../support/viewpoint-fixtures.ts';
import { getDefaultCriteria } from '../../../src/backend/domain/evaluation/default-criteria.ts';
import { expectCardLabels } from '../../support/card-table.ts';

interface Scenario {
  readonly dashboard?: (request: FakeRequest) => Response | Promise<Response>;
  readonly detail?: (request: FakeRequest) => Response;
  readonly series?: (request: FakeRequest) => Response | Promise<Response>;
  readonly observations?: (request: FakeRequest) => Response;
  readonly equipment?: (request: FakeRequest) => Response;
}

function handlerOf(scenario: Scenario = {}): FakeHandler {
  // 共通のルート（設備の階層・未読の件数・ステータスコード）に、このテストのルートを重ねる
  const baseRoutes = withBaseRoutes({
    'GET /equipment': scenario.equipment ?? (() => jsonResponse(equipmentTree())),
    'GET /dashboard': scenario.dashboard ?? (() => jsonResponse(dashboard())),
    'GET /observations': scenario.observations ?? (() => jsonResponse(observationList())),
  });
  return (request) => {
    if (request.path.endsWith('/series')) {
      return (scenario.series ?? (() => jsonResponse(series())))(request);
    }
    if (request.path.startsWith('/viewpoints/')) {
      return (scenario.detail ?? (() => jsonResponse(detail())))(request);
    }
    return baseRoutes(request);
  };
}

function renderPath(path: string, scenario: Scenario = {}) {
  window.history.pushState(null, '', path);
  const session = createMemorySession(WORKER_LOGIN);
  const fake = createFakeFetch(handlerOf(scenario));
  const view = render(<App session={session} fetchFn={fake.fetchFn} />);
  return { ...fake, ...view };
}

const detailCalls = (calls: readonly FakeRequest[]) =>
  calls.filter((call) => call.path === '/viewpoints/environmentalAdaptability');

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

const dashboardCalls = (calls: readonly FakeRequest[]) =>
  calls.filter((call) => call.path === '/dashboard');

function cardOf(name: string): HTMLElement {
  const element = screen.getByRole('heading', { name }).closest('li');
  if (element === null) {
    throw new Error('テストの前提: カードがある');
  }
  return element;
}

describe('ダッシュボード: 操作（対象のハウス・期間・更新。Issue #355）', () => {
  it('視点（短期・長期）の切り替えはなく、長期の評価を、選んだ期間で示す。期間は URL のクエリで保持し、切り替えると、そのクエリで取得し直す', async () => {
    const { calls } = renderPath('/?periodDays=30');

    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
    expect(screen.queryByRole('radio', { name: '短期' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '長期' })).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('期間').value).toBe('30');
    const first = dashboardCalls(calls)[0];
    expect(first?.query.get('horizon')).toBe('LONG');
    expect(first?.query.get('periodDays')).toBe('30');

    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '90' } });
    await waitFor(() => {
      expect(window.location.search).toBe('?periodDays=90');
    });
    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('periodDays')).toBe('90');
    });
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('期間').options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['当日', '直近7日', '直近30日', '直近60日', '直近90日']);
  });

  it('期間を選んでいないときは、期間を送らず（観点ごとの既定。満足度は 30 日）、期間の選択は、直近7日を示す', async () => {
    const { calls } = renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    expect(dashboardCalls(calls)[0]?.query.has('periodDays')).toBe(false);
    expect(dashboardCalls(calls)[0]?.query.get('horizon')).toBe('LONG');
    expect(screen.getByLabelText<HTMLSelectElement>('期間').value).toBe('7');
  });

  it('古い URL の視点（horizon=SHORT）は、使わず、長期で取得する。期間を選ぶと、URL から視点が外れる', async () => {
    const { calls } = renderPath('/?horizon=SHORT&periodDays=30');

    await screen.findByRole('heading', { name: '安全性' });
    expect(dashboardCalls(calls)[0]?.query.get('horizon')).toBe('LONG');
    expect(dashboardCalls(calls)[0]?.query.get('periodDays')).toBe('30');

    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '60' } });

    await waitFor(() => {
      expect(window.location.search).toBe('?periodDays=60');
    });
  });

  it('期間を選ぶと、その期間で取得する（満足度も、選んだ期間）', async () => {
    const { calls } = renderPath('/');
    await screen.findByRole('heading', { name: '安全性' });

    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '60' } });

    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('periodDays')).toBe('60');
    });
    // 観点の詳細は、ドロワーで開く（ダッシュボードの URL に、観点と、選んだ期間を付ける。Issue #357）
    expect(within(cardOf('満足度')).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      '/?viewpoint=satisfaction&periodDays=60',
    );
  });

  it('不正なクエリは、既定値（直近7日）として扱う', async () => {
    renderPath('/?horizon=MIDDLE&periodDays=5');

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByLabelText<HTMLSelectElement>('期間').value).toBe('7');
  });

  it('「対象のハウス」は、ハウスだけを選べる（ロボット・センサーは、選択肢にない）。選ぶと、そのハウスで取得し直す', async () => {
    const { calls } = renderPath('/', { equipment: () => jsonResponse(twoFacilityTree()) });
    await screen.findByRole('heading', { name: '安全性' });
    const select = screen.getByLabelText<HTMLSelectElement>('対象のハウス');
    await waitFor(() => {
      expect(select.options).toHaveLength(2);
    });

    expect([...select.options].map((option) => option.textContent)).toEqual(['ハウス1', 'ハウス2']);
    expect(select.value).toBe('HOUSE-01');
    expect(dashboardCalls(calls)[0]?.query.get('equipmentId')).toBe('HOUSE-01');

    fireEvent.change(select, { target: { value: 'HOUSE-02' } });

    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('equipmentId')).toBe('HOUSE-02');
    });
    expect(select.value).toBe('HOUSE-02');
    // ヘッダーに、対象の設備の選択はない（ダッシュボードの中にある）
    expect(within(screen.getByRole('banner')).queryByLabelText('対象の設備')).toBeNull();
  });

  it('観点の詳細で、ロボットを選んだあとに、ダッシュボードへ戻ると、そのロボットのハウスを対象にする（ダッシュボードはハウス単位）', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
      equipment: () => jsonResponse(twoFacilityTree()),
    });
    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(3);
    });

    fireEvent.change(select, { target: { value: 'ROBOT-02' } });
    fireEvent.click(
      within(await screen.findByRole('navigation', { name: 'パンくず' })).getByRole('link', {
        name: 'ダッシュボード',
      }),
    );

    expect(await screen.findByLabelText<HTMLSelectElement>('対象のハウス')).toBeDefined();
    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('equipmentId')).toBe('HOUSE-02');
    });
    expect(screen.getByLabelText<HTMLSelectElement>('対象のハウス').value).toBe('HOUSE-02');

    // 選択は、そのハウスにそろう: カードから開く観点の詳細は、ロボットでなく、ダッシュボードの示すハウスの詳細
    const [cardLink] = within(cardOf('安全性')).getAllByRole('link');
    if (cardLink === undefined) {
      throw new Error('テストの前提: カードのリンクがある');
    }
    fireEvent.click(cardLink);
    const detailSelect = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    expect(detailSelect.value).toBe('HOUSE-02');
  });

  it('「更新」を押すと、約 10 秒の更新を待たずに、すぐ取得し直す。取得の間は、更新中で、押しても重ねて取得しない', async () => {
    let release: (() => void) | undefined;
    let calls: readonly FakeRequest[] = [];
    let hold = false;
    const view = renderPath('/', {
      dashboard: () => {
        if (!hold) {
          return jsonResponse(dashboard());
        }
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(jsonResponse(dashboard()));
          };
        });
      },
    });
    calls = view.calls;
    await screen.findByRole('heading', { name: '安全性' });
    const before = dashboardCalls(calls).length;
    const button = screen.getByRole('button', { name: '更新' });
    expect(button.getAttribute('aria-disabled')).toBe('false');
    hold = true;

    fireEvent.click(button);

    await waitFor(() => {
      expect(dashboardCalls(calls)).toHaveLength(before + 1);
    });
    expect(screen.getByRole('button', { name: '更新中…' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '更新中…' }));
    expect(dashboardCalls(calls)).toHaveLength(before + 1);

    hold = false;
    release?.();

    expect(await screen.findByRole('button', { name: '更新' })).toBeDefined();
    expect(screen.getByRole('button', { name: '更新' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });
});

describe('ダッシュボード: 表示（Issue #355・#356）', () => {
  it('最終のデータ取得日時と最終の評価日時を、ダッシュボードの中に示す（ヘッダーには、示さない）', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    const meta = screen.getByTestId('dashboard-meta');
    expect(meta.textContent).toContain('最終のデータ取得: 2026/10/09 11:55:00');
    expect(meta.textContent).toContain('最終の評価: 2026/10/09 12:00:00');
    expect(within(screen.getByRole('banner')).queryByText(/最終のデータ取得/)).toBeNull();
  });

  it('評価がまだなら、最終の評価日時を示さない', async () => {
    renderPath('/', {
      dashboard: () =>
        new Response(JSON.stringify({ ...dashboard(), evaluatedAt: null }), { status: 200 }),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.queryByText(/最終の評価/)).toBeNull();
  });

  it('判定の対象期間が、全観点で同じなら、上部に 1 回だけ示し、カードごとには示さない（評価前の観点は、除いて比べる）', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByTestId('evaluated-period-common').textContent).toContain(
      '判定の対象期間: 2026/10/02 12:00:00 〜 2026/10/09 12:00:00',
    );
    expect(document.querySelectorAll('.viewpoint-card .evaluated-period')).toHaveLength(0);
  });

  it('判定の対象期間が、観点で違うとき（例: 満足度の既定は 30 日）は、上部にまとめず、カードごとに示す', async () => {
    renderPath('/', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card(),
              card({
                viewpointId: 'satisfaction',
                name: '満足度',
                evaluatedFrom: '2026-09-09T03:00:00.000Z',
                evaluatedTo: '2026-10-09T03:00:00.000Z',
              }),
            ],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.queryByTestId('evaluated-period-common')).toBeNull();
    expect(within(cardOf('安全性')).getByText(/判定の対象期間: 2026\/10\/02/)).toBeDefined();
    expect(within(cardOf('満足度')).getByText(/判定の対象期間: 2026\/09\/09/)).toBeDefined();
  });

  it('期間のある観点がなければ（すべて評価前）、判定の対象期間は、示さない', async () => {
    renderPath('/', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [card({ status: 'UNKNOWN', evaluatedFrom: null, evaluatedTo: null })],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.queryByTestId('evaluated-period-common')).toBeNull();
    expect(screen.queryByText(/判定の対象期間/)).toBeNull();
  });

  it('期間を選んでいないとき、満足度のカードの詳細へのリンクは、期間を付けない（満足度の既定の 30 日で開く）', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '満足度' });

    expect(
      within(cardOf('満足度'))
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/?viewpoint=satisfaction', '/?viewpoint=satisfaction']);
  });

  it('カード・観点別の状態の表のリンクは、観点の詳細のドロワーを開く（ダッシュボードの URL に観点を付ける）。期間は、選んでいるときだけ引き継ぐ', async () => {
    renderPath('/?periodDays=60');

    await screen.findByRole('heading', { name: '安全性' });

    expect(
      within(cardOf('安全性'))
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/?viewpoint=safety&periodDays=60', '/?viewpoint=safety&periodDays=60']);
    expect(
      within(screen.getByTestId('status-row-safety')).getByRole('link').getAttribute('href'),
    ).toBe('/?viewpoint=safety&periodDays=60');
    expect(within(cardOf('満足度')).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      '/?viewpoint=satisfaction&periodDays=60',
    );
    expect(
      within(screen.getByTestId('status-row-satisfaction')).getByRole('link').getAttribute('href'),
    ).toBe('/?viewpoint=satisfaction&periodDays=60');
  });

  it('メトリクスごとの判定を、アイコンと文字で示す（色だけに頼らない）。ステータスコードの名称も同様', async () => {
    renderPath('/', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card({
                metrics: { emergencyStopPerHour: 0.03, nearMissPerHour: null },
                metricStatuses: { emergencyStopPerHour: 'CAUTION' },
                statusDetail: { code: 'FALLEN', name: '転倒（姿勢異常）', category: 'ERROR' },
              }),
            ],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '安全性' });
    const element = cardOf('安全性');

    const emergency = within(element).getByText('0.030回/時間').closest('dd');
    expect(emergency?.className).toContain('metric-caution');
    expect(emergency?.textContent).toContain('注意');
    const nearMiss = within(element).getByText('—').closest('dd');
    expect(nearMiss?.className).toContain('metric-none');
    const status = within(element).getByText('転倒（姿勢異常）').closest('dd');
    expect(status?.className).toContain('metric-error');
    expect(status?.textContent).toContain('異常');
  });

  it('データが未取得なら、その旨と、データ入力・取り込み設定への導線を示す。古い場合は警告。いずれも、取得日時の欄（ダッシュボードの中）に示す', async () => {
    const none = renderPath('/', {
      dashboard: () =>
        jsonResponse(dashboard({ dataFreshness: 'NONE', lastReceivedAt: null, evaluatedAt: null })),
    });

    const notice = (await screen.findByText(/データがまだ取り込まれていません/)).closest('div');
    if (notice === null) {
      throw new Error('テストの前提: 通知がある');
    }
    expect(notice.textContent).toContain('データがまだ取り込まれていません');
    expect(within(notice).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );
    expect(within(notice).getByRole('link', { name: '取り込みへ' }).getAttribute('href')).toBe(
      '/settings/ingestion',
    );
    expect(within(screen.getByTestId('dashboard-meta')).getByText('未取得')).toBeDefined();
    none.unmount();

    renderPath('/', { dashboard: () => jsonResponse(dashboard({ dataFreshness: 'STALE' })) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('データが古くなっています');
    expect(within(screen.getByTestId('dashboard-meta')).getByText('（古い）')).toBeDefined();
  });
});

describe('ダッシュボード: 状態の見せ方（Issue #356）', () => {
  it('見出しは、状態ごとの観点の数（タイル）・観点別の状態（表）・観点ごとの診断と推奨アクション（カード）で、見分けがつく', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['状態ごとの観点の数', '観点別の状態', '観点ごとの診断と推奨アクション']);
  });

  it('正常・注意・異常・不明の件数の下に、観点別の状態を、1 行に 1 観点の表（観点名・状態）で示す', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    const table = screen.getByTestId('viewpoint-status-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['観点', '状態']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('安全性'),
      expect.stringContaining('収穫速度'),
      expect.stringContaining('満足度'),
    ]);
    expect(rows.map((row) => within(row).getByText(/^(正常|注意|異常|不明)$/).textContent)).toEqual(
      ['正常', '注意', '不明'],
    );
    // 件数のタイルの後ろ、カードの前に並ぶ
    const tiles = screen.getByTestId('summary-NORMAL');
    const firstCard = screen.getByTestId('card-safety');
    expect(tiles.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      table.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('カードのステータスが、短期（直近 24 時間）の評価で決まっている（この期間の評価より悪い）ときは、その旨を示す', async () => {
    renderPath('/', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card({
                status: 'ERROR',
                statuses: { short: 'ERROR', long: 'NORMAL' },
              }),
              card({
                viewpointId: 'harvestSpeed',
                name: '収穫速度',
                status: 'CAUTION',
                statuses: { short: 'NORMAL', long: 'CAUTION' },
              }),
              card({
                viewpointId: 'durability',
                name: '耐久性',
                status: 'NORMAL',
                statuses: { short: null, long: 'NORMAL' },
              }),
            ],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByTestId('short-worse-safety').textContent).toBe(
      '直近 24 時間の評価は「異常」です（この期間の評価は「正常」）。ステータスは、悪い方を示しています',
    );
    // 長期の評価と同じ（長期が悪い・短期の評価がない）カードには、示さない
    expect(screen.queryByTestId('short-worse-harvestSpeed')).toBeNull();
    expect(screen.queryByTestId('short-worse-durability')).toBeNull();
  });

  it('この期間の評価が不明で、短期の評価だけがあるときも、その旨を示す', async () => {
    renderPath('/', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card({ status: 'CAUTION', statuses: { short: 'CAUTION', long: 'UNKNOWN' } }),
            ],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByTestId('short-worse-safety').textContent).toContain(
      '直近 24 時間の評価は「注意」です（この期間の評価は「不明」）',
    );
  });
});

describe('観点の詳細（UC-02・UC-04。SC-03）', () => {
  it('診断結果（ステータス・診断メッセージ・推奨アクション・判定の対象期間）と、視点ごとの判定を表示する', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const diagnosisPanel = await screen.findByTestId('diagnosis');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('環境適応性');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('注意');
    expect(within(diagnosisPanel).getByTestId('diagnostic-message').textContent).toContain(
      '温度 27.0℃（注意）',
    );
    expect(within(diagnosisPanel).getByTestId('recommended-action').textContent).toContain(
      'ハウスの環境を現場で確認し',
    );
    expect(
      within(diagnosisPanel).getAllByText(
        /判定の対象期間: 2026\/10\/02 12:00:00 〜 2026\/10\/09 12:00:00/,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(diagnosisPanel).getByText('長期（直近7日）', { selector: '.diagnosis-horizon' }),
    ).toBeDefined();
    const shortCard = within(diagnosisPanel).getByTestId('horizon-short');
    expect(shortCard.textContent).toContain('短期（直近24時間）');
    expect(shortCard.textContent).toContain('正常');
    expect(within(diagnosisPanel).getByTestId('horizon-long').textContent).toContain('注意');
    expect(within(diagnosisPanel).queryByTestId('unknown-guide')).toBeNull();
    // 対象の設備は、ページの中の選択（以前は、ヘッダー）。選んでいる設備を示す
    expect(screen.getByLabelText<HTMLSelectElement>('対象の設備').value).toBe('HOUSE-01');
  });

  it('「対象の設備」は、ハウス・ロボット・センサーを選べる（ページの中にある。以前は、ヘッダー）。選ぶと、その設備で取得し直す', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability');
    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options).toHaveLength(3);
    });

    expect([...select.options].map((option) => option.textContent)).toEqual([
      'ハウス1',
      '　収穫ロボット1（ロボット）',
      '　環境センサー1（センサー）',
    ]);
    expect(within(screen.getByRole('banner')).queryByLabelText('対象の設備')).toBeNull();

    fireEvent.change(select, { target: { value: 'SENSOR-01' } });

    await waitFor(() => {
      expect(detailCalls(calls).at(-1)?.query.get('equipmentId')).toBe('SENSOR-01');
    });
    expect(select.value).toBe('SENSOR-01');
  });

  it('設備が 1 つもなければ、「対象の設備」の選択を無効にする', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      equipment: () => jsonResponse({ facilities: [] }),
    });

    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');

    await waitFor(() => {
      expect(select.disabled).toBe(true);
    });
  });

  it('根拠のメトリクス: 全メトリクスの値（欠損は「—」）と、指標ごとの判定（判定なしを含む）、主要の印を表示する', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const basis = await screen.findByTestId('basis');

    const temperature = within(basis).getByTestId('metric-temperatureCelsius');
    expect(temperature.textContent).toContain('温度');
    expect(temperature.textContent).toContain('27.0℃');
    expect(temperature.textContent).toContain('注意');
    expect(temperature.textContent).toContain('主要');
    const illuminance = within(basis).getByTestId('metric-illuminanceLux');
    expect(illuminance.textContent).toContain('—');
    expect(illuminance.textContent).toContain('不明');
    const co2 = within(basis).getByTestId('metric-co2Ppm');
    expect(co2.textContent).toContain('900ppm');
    expect(co2.textContent).toContain('判定なし');
    expect(co2.textContent).not.toContain('主要');
    expect(within(basis).queryByTestId('metric-status')).toBeNull();
    // 画面での呼び方（用語集）: 「メトリクス」ではなく「指標」
    expect(within(basis).getByRole('heading', { name: '根拠の指標' })).toBeDefined();
    expect(
      within(basis)
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .slice(0, 2),
    ).toEqual(['指標', '値']);
    expect(basis.textContent).not.toContain('メトリクス');
  });

  it('判断基準: 指標ごとの条件名と、正常・注意・異常の条件を表示し、既定値であることを示す。編集への導線がある', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const criteria = await screen.findByTestId('criteria');

    expect(within(criteria).getByTestId('criteria-state').textContent).toBe('既定値');
    const temperature = within(criteria).getByTestId('criterion-temperatureCelsius');
    expect(temperature.textContent).toContain('10℃以上25℃未満');
    expect(temperature.textContent).toContain('0℃以上10℃未満、25℃以上35℃未満');
    expect(temperature.textContent).toContain('0℃未満、35℃以上');
    expect(within(criteria).getByTestId('criterion-illuminanceLux').textContent).toContain(
      '20,000lx以上40,000lx未満',
    );
    expect(
      within(criteria).getByRole('link', { name: '判断基準を編集' }).getAttribute('href'),
    ).toBe('/viewpoints/environmentalAdaptability/criteria');
    expect(within(criteria).queryByTestId('criteria-status-note')).toBeNull();
  });

  it('変更した判断基準・ステータスコードで判定する観点: 変更済みと版、カスタムの旨、ステータスコードは名称で表示する', async () => {
    renderPath('/viewpoints/harvestSpeed', { detail: () => jsonResponse(speedDetail()) });

    const criteria = await screen.findByTestId('criteria');
    const basis = screen.getByTestId('basis');

    expect(within(criteria).getByTestId('criteria-state').textContent).toBe('変更済み（版: V2）');
    expect(within(criteria).getByTestId('criteria-status-note').textContent).toContain(
      'メニューの「ステータスコード」',
    );
    expect(within(basis).getByTestId('metric-status').textContent).toContain('収穫中');
    expect(within(basis).getByTestId('metric-status').textContent).toContain('正常');
    expect(screen.getByText('カスタムの判断基準')).toBeDefined();
  });

  it('ステータスコードが未取得なら、名称は「—」で判定なし', async () => {
    renderPath('/viewpoints/harvestSpeed', {
      detail: () =>
        jsonResponse(
          speedDetail({
            selected: diagnosis({ status: 'UNKNOWN', statusDetail: null }),
          }),
        ),
    });

    const row = await screen.findByTestId('metric-status');

    expect(row.textContent).toContain('—');
    expect(row.textContent).toContain('判定なし');
  });

  it('評価できない（不明）場合は、データ不足の旨と、データ入力・取り込み状況への導線を表示する（UC-04）', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      detail: () =>
        jsonResponse(
          detail({
            status: 'UNKNOWN',
            selected: diagnosis({
              status: 'UNKNOWN',
              diagnosticMessage: '環境適応性: データ不足のため評価できません。未取得の項目: 温度',
              recommendedAction: 'データの取得・入力を確認してください（取り込みの状況、手動入力）',
            }),
          }),
        ),
    });

    const guide = await screen.findByTestId('unknown-guide');

    expect(guide.textContent).toContain('データ不足のため評価できません');
    expect(within(guide).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );
    expect(within(guide).getByRole('link', { name: '取り込みへ' })).toBeDefined();
    expect(screen.getByTestId('recommended-action').textContent).toContain(
      'データの取得・入力を確認',
    );
  });

  it('評価がまだなら、評価前である旨を示し、メトリクスは値なしで表示する', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      detail: () =>
        jsonResponse(
          detail({
            isEvaluated: false,
            status: 'UNKNOWN',
            short: null,
            long: null,
            selected: null,
            metrics: detail().metrics.map((row) => ({
              ...row,
              value: null,
              indicatorStatus: null,
            })),
          }),
        ),
    });

    const panel = await screen.findByTestId('diagnosis');

    expect(within(panel).getAllByText(/まだ評価されていません/).length).toBeGreaterThan(0);
    expect(within(panel).getByTestId('horizon-long').textContent).toContain(
      'まだ評価されていません',
    );
    expect(within(panel).getByTestId('horizon-short').textContent).toContain(
      'まだ評価されていません',
    );
  });

  it('評価前（不明）でも、データの取得・入力を確認する推奨アクションと、データ入力・取り込み状況への導線を表示する（UC-04。ダッシュボードの評価前のカードと同じ推奨アクション）', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      detail: () =>
        jsonResponse(
          detail({
            isEvaluated: false,
            status: 'UNKNOWN',
            short: null,
            long: null,
            selected: null,
          }),
        ),
    });

    const action = await screen.findByTestId('recommended-action');

    expect(action.textContent).toContain(UNKNOWN_ACTION);
    expect(action.textContent).toContain('推奨アクション');
    const guide = screen.getByTestId('unknown-guide');
    expect(within(guide).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );
    expect(within(guide).getByRole('link', { name: '取り込みへ' }).getAttribute('href')).toBe(
      '/settings/ingestion',
    );
  });

  it('短期評価を持たない観点: 短期の判定は「短期評価はありません」。短期を指定すると、長期を表示している旨を示す', async () => {
    renderPath('/viewpoints/durability?horizon=SHORT', {
      detail: () =>
        jsonResponse(
          detail({
            viewpointId: 'durability',
            name: '耐久性',
            hasShortHorizon: false,
            horizon: 'SHORT',
            horizonUsed: 'LONG',
            short: null,
          }),
        ),
      series: () =>
        jsonResponse(
          series({
            viewpointId: 'durability',
            horizon: 'SHORT',
            horizonUsed: 'LONG',
            hasShortHorizon: false,
            feedback: { short: null, long: diagnosis() },
          }),
        ),
    });

    const panel = await screen.findByTestId('diagnosis');
    const trend = await screen.findByTestId('trend');

    expect(within(panel).getByTestId('horizon-short').textContent).toContain(
      '短期評価はありません',
    );
    expect(
      within(panel).getByText('この観点は短期評価を持たないため、長期の結果を表示しています'),
    ).toBeDefined();
    expect(within(trend).queryByTestId('feedback-short')).toBeNull();
    expect(within(trend).getByTestId('no-short-note').textContent).toContain(
      '短期評価はありません',
    );
    expect(
      within(trend).getByText('この観点は短期評価を持たないため、長期の結果を表示しています'),
    ).toBeDefined();
  });

  it('視点（短期・長期）と期間を切り替えると、URL のクエリを更新し、詳細・推移を取得し直す', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability?horizon=LONG&periodDays=7');
    await screen.findByTestId('diagnosis');

    fireEvent.click(screen.getByRole('radio', { name: '短期' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=SHORT&periodDays=7');
    });
    fireEvent.change(screen.getByLabelText('長期の期間'), { target: { value: '30' } });
    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=SHORT&periodDays=30');
    });

    await waitFor(() => {
      const last = detailCalls(calls).at(-1);
      expect(last?.query.get('horizon')).toBe('SHORT');
      expect(last?.query.get('periodDays')).toBe('30');
      expect(last?.query.get('equipmentId')).toBe('HOUSE-01');
    });
    expect(
      calls
        .filter((call) => call.path.endsWith('/series'))
        .at(-1)
        ?.query.get('periodDays'),
    ).toBe('30');
  });

  it('ダッシュボードへ戻るリンクは、期間だけを引き継ぐ（視点は、ダッシュボードにない）。期間を選んでいなければ、付けない', async () => {
    const view = renderPath('/viewpoints/environmentalAdaptability?horizon=SHORT&periodDays=30');

    const breadcrumb = await screen.findByRole('navigation', { name: 'パンくず' });
    const link = within(breadcrumb).getByRole('link', { name: 'ダッシュボード' });

    expect(link.getAttribute('href')).toBe('/?periodDays=30');
    view.unmount();

    renderPath('/viewpoints/environmentalAdaptability?horizon=SHORT');
    const second = within(await screen.findByRole('navigation', { name: 'パンくず' })).getByRole(
      'link',
      { name: 'ダッシュボード' },
    );
    expect(second.getAttribute('href')).toBe('/');
  });

  it('選んだ設備では評価しない観点は、その旨と、設備の選び直しを示す', async () => {
    renderPath('/viewpoints/harvestAccuracy', {
      detail: () => errorResponse(404, 'NOT_FOUND', 'この設備では評価しない観点です'),
    });

    const message = await screen.findByTestId('not-applicable');

    expect(message.textContent).toContain('この設備では評価しない観点です');
    expect(message.textContent).toContain('設備を選び直してください');
  });

  it('その他のエラーは、利用者向けのメッセージと、再読み込みを示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      detail: () => errorResponse(500, 'INTERNAL_ERROR', 'サーバーでエラーが発生しました'),
    });

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('サーバーでエラーが発生しました');
    expect(within(alert).getByRole('button', { name: '再読み込み' })).toBeDefined();
  });

  it('設備の階層を取得できなければ、エラーを示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      equipment: () => errorResponse(500, 'INTERNAL_ERROR', '設備を取得できません'),
    });

    expect((await screen.findByRole('alert')).textContent).toContain('設備を取得できません');
  });

  it('読み込み中は、その旨を示す', () => {
    renderPath('/viewpoints/environmentalAdaptability');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード');
  });

  it('満足度の観点は、満足度の詳細へ移る', async () => {
    renderPath('/viewpoints/satisfaction', {
      detail: () => jsonResponse(satisfactionDetail([5, 5, 5, 5, 5, 5, 5, 5, 5])),
    });

    expect(await screen.findByRole('heading', { name: /満足度の詳細/ })).toBeDefined();
    expect(window.location.pathname).toBe('/satisfaction');
  });
});

describe('観点の詳細: 推移（UC-03）', () => {
  it('主要メトリクスはグラフを開いて表示し、それ以外は閉じておく。期間の平均値を併記する', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const trend = await screen.findByTestId('trend');

    const temperature = within(trend).getByTestId('trend-temperatureCelsius');
    expect(temperature.getAttribute('open')).not.toBeNull();
    expect(
      within(temperature).getByTestId('trend-average-temperatureCelsius').textContent,
    ).toContain('期間の平均値: 23.5℃');
    expect(temperature.querySelector('svg.line-chart')).not.toBeNull();
    // 帯・平均線を描く
    expect(temperature.querySelectorAll('rect.chart-band').length).toBeGreaterThan(0);
    expect(temperature.querySelector('[data-testid="chart-average-line"]')).not.toBeNull();
    const co2 = within(trend).getByTestId('trend-co2Ppm');
    expect(co2.getAttribute('open')).toBeNull();
    expect(co2.querySelector('svg.line-chart')).not.toBeNull();
    expect(within(trend).getByText(/日ごと/)).toBeDefined();
  });

  it('データのない指標は、グラフの代わりに、データがない旨と、平均値は「—」', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const humidity = await screen.findByTestId('trend-humidityPercent');

    expect(humidity.textContent).toContain('この期間のデータがありません');
    expect(humidity.querySelector('svg')).toBeNull();
    expect(within(humidity).getByTestId('trend-average-humidityPercent').textContent).toContain(
      '—',
    );
  });

  it('判断基準のない指標（メトリクス）は、背景の帯なしで描く。1時間ごとの推移も描く', async () => {
    const hourly = Array.from({ length: 24 }, (_, index) => ({
      at: new Date(Date.parse('2026-10-08T04:00:00.000Z') + index * 3_600_000).toISOString(),
      value: index === 10 ? 50 : null,
    }));
    renderPath('/viewpoints/harvestSpeed?horizon=SHORT', {
      detail: () => jsonResponse(speedDetail()),
      series: () =>
        jsonResponse(
          series({
            viewpointId: 'harvestSpeed',
            horizon: 'SHORT',
            horizonUsed: 'SHORT',
            periodDays: null,
            bucket: 'HOUR',
            metrics: [
              { metricId: 'harvestOperatingHours', isPrimary: false, points: hourly, average: 50 },
            ],
          }),
        ),
    });

    const trend = await screen.findByTestId('trend');
    const metric = within(trend).getByTestId('trend-harvestOperatingHours');

    expect(metric.querySelectorAll('rect.chart-band')).toHaveLength(0);
    expect(metric.querySelectorAll('circle.chart-dot')).toHaveLength(1);
    expect(within(trend).getByText(/1時間ごと/)).toBeDefined();
  });

  it('ステータスの推移: 期間の開始時点と、期間内の変化を、時系列で表示する', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const history = await screen.findByTestId('status-history');

    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('期間の開始時点');
    expect(items[0]?.textContent).toContain('正常');
    expect(items[1]?.textContent).toContain('2026/10/06 12:00:00');
    expect(items[1]?.textContent).toContain('注意');
    const segments = history.querySelectorAll('.status-segment');
    expect([...segments].map((segment) => segment.textContent)).toEqual(['正常', '注意']);
  });

  it.each<[SeriesResponse['statusHistory'], string, number]>([
    [{ initial: null, changes: [] }, 'この期間に記録されたステータスの変化はありません', 0],
    [{ initial: 'ERROR', changes: [] }, '期間の開始時点', 1],
    [
      { initial: null, changes: [{ changedAt: '2026-10-08T03:00:00.000Z', status: 'ERROR' }] },
      '2026/10/08 12:00:00',
      1,
    ],
  ])('ステータスの推移（%j）の表示', async (statusHistory, expectedText, segmentCount) => {
    renderPath('/viewpoints/environmentalAdaptability', {
      series: () => jsonResponse(series({ statusHistory })),
    });

    const history = await screen.findByTestId('status-history');

    expect(history.textContent).toContain(expectedText);
    expect(history.querySelectorAll('.status-segment')).toHaveLength(segmentCount);
  });

  it.each<[string, SeriesResponse['statusHistory']]>([
    [
      '期間の開始時点のステータスがない（変化が、期間の終わり近くだけ）',
      {
        initial: null,
        changes: [
          { changedAt: '2026-10-09T02:58:00.000Z', status: 'CAUTION' },
          { changedAt: '2026-10-09T02:59:00.000Z', status: 'NORMAL' },
        ],
      },
    ],
    [
      '期間の開始時点のステータスがある',
      {
        initial: 'NORMAL',
        changes: [{ changedAt: '2026-10-06T03:00:00.000Z', status: 'CAUTION' }],
      },
    ],
  ])(
    'ステータスの推移の帯は、区間の比率に応じて、帯の全幅を使う（%s）',
    async (_name, statusHistory) => {
      renderPath('/viewpoints/environmentalAdaptability', {
        series: () => jsonResponse(series({ statusHistory })),
      });

      const history = await screen.findByTestId('status-history');

      const grows = [...history.querySelectorAll<HTMLElement>('.status-segment')].map((segment) =>
        Number(segment.style.flexGrow),
      );
      expect(grows.reduce((sum, grow) => sum + grow, 0)).toBeCloseTo(1, 5);
    },
  );

  it('視点ごとのフィードバック（診断メッセージ・推奨アクション）を、短期・長期で表示する', async () => {
    renderPath('/viewpoints/environmentalAdaptability');

    const trend = await screen.findByTestId('trend');

    expect(within(trend).getByTestId('feedback-short').textContent).toContain('正常');
    expect(within(trend).getByTestId('feedback-short').textContent).toContain('推奨アクション');
    expect(within(trend).getByTestId('feedback-long').textContent).toContain('注意');
  });

  it('フィードバックが未評価なら、その旨を示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      series: () => jsonResponse(series({ feedback: { short: null, long: null } })),
    });

    const trend = await screen.findByTestId('trend');

    expect(within(trend).getByTestId('feedback-short').textContent).toContain(
      'まだ評価されていません',
    );
    expect(within(trend).getByTestId('feedback-long').textContent).toContain(
      'まだ評価されていません',
    );
  });

  it('推移の取得に失敗しても、詳細は表示し、推移の欄にエラーと再読み込みを示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      series: () => errorResponse(500, 'INTERNAL_ERROR', '推移を取得できません'),
    });

    await screen.findByTestId('diagnosis');
    const alerts = await screen.findAllByRole('alert');

    expect(alerts.some((alert) => alert.textContent.includes('推移を取得できません'))).toBe(true);
    expect(screen.getByTestId('basis')).toBeDefined();
  });

  it('推移を読み込んでいる間は、読み込み中を示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      // 応答が返らない（読み込み中のまま）
      series: () => new Promise<Response>(() => undefined),
    });

    await screen.findByTestId('diagnosis');

    expect(screen.queryByTestId('trend')).toBeNull();
  });
});

describe('観点の詳細: 元データ（UC-02）', () => {
  it('分析に使ったデータの一覧: 計測日時・設備・項目・値（単位つき）・取得元・状態を表示する', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability');

    const source = await screen.findByTestId('source-data');
    await within(source).findByText('27.5℃');

    const rows = within(source).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain('2026/10/09 11:00:00');
    expect(rows[0]?.textContent).toContain('環境センサー1');
    expect(rows[0]?.textContent).toContain('温度（環境情報）');
    expect(rows[0]?.textContent).toContain('自動取り込み');
    expect(rows[0]?.textContent).toContain('有効');
    // ステータスコードは名称。欠損は「—」。単位は項目カタログから。設備・項目が不明でも、識別子で表示する
    expect(rows[1]?.textContent).toContain('収穫中');
    expect(rows[1]?.textContent).toContain('収穫ロボット1');
    expect(rows[2]?.textContent).toContain('—');
    expect(rows[2]?.textContent).toContain('手動入力');
    expect(rows[2]?.textContent).toContain('欠損');
    expect(rows[3]?.textContent).toContain('30,000lx');
    expect(rows[3]?.textContent).toContain('遅延');
    expect(rows[4]?.textContent).toContain('GONE-01');
    expect(rows[4]?.textContent).toContain('customUnknownItem');
    expect(rows[4]?.textContent).toContain('UNDEFINED_CODE');
    expect(rows[4]?.textContent).toContain('不正');
    // 診断の対象期間・設備・観点で取得する
    const request = calls.find((call) => call.path === '/observations');
    expect(request?.query.get('equipmentId')).toBe('HOUSE-01');
    expect(request?.query.get('viewpointId')).toBe('environmentalAdaptability');
    expect(request?.query.get('from')).toBe('2026-10-02T03:00:00.000Z');
    expect(request?.query.get('to')).toBe('2026-10-09T03:00:00.000Z');
    expect(request?.query.get('sort')).toBe('observedAt');
    expect(request?.query.get('direction')).toBe('desc');
    expect(request?.query.get('limit')).toBe('10');
    expect(request?.query.has('q')).toBe(false);
    expect(
      within(source).getByRole('link', { name: '取り込み済みデータ一覧へ' }).getAttribute('href'),
    ).toBe('/observations');
  });

  it('評価がまだなら、期間で絞り込まずに取得する', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
      detail: () =>
        jsonResponse(detail({ isEvaluated: false, selected: null, short: null, long: null })),
    });

    await screen.findByTestId('source-data');

    await waitFor(() => {
      expect(calls.some((call) => call.path === '/observations')).toBe(true);
    });
    const request = calls.find((call) => call.path === '/observations');
    expect(request?.query.has('from')).toBe(false);
    expect(request?.query.has('to')).toBe(false);
  });

  it('キーワード・並べ替え・向きを変えると、その条件で取得し直す（先頭のページから）。空白だけのキーワードは送らない', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability');
    const source = await screen.findByTestId('source-data');
    await within(source).findByText('27.5℃');
    const observationCalls = () => calls.filter((call) => call.path === '/observations');

    fireEvent.change(within(source).getByLabelText('キーワード'), { target: { value: '  温度 ' } });
    await waitFor(() => {
      expect(observationCalls().at(-1)?.query.get('q')).toBe('温度');
    });
    fireEvent.change(within(source).getByLabelText('キーワード'), { target: { value: '   ' } });
    await waitFor(() => {
      expect(observationCalls().at(-1)?.query.has('q')).toBe(false);
    });
    fireEvent.change(within(source).getByLabelText('並べ替え', { selector: 'select' }), {
      target: { value: 'value' },
    });
    await waitFor(() => {
      expect(observationCalls().at(-1)?.query.get('sort')).toBe('value');
    });
    fireEvent.change(within(source).getByLabelText('並べ替えの向き'), { target: { value: 'asc' } });
    await waitFor(() => {
      expect(observationCalls().at(-1)?.query.get('direction')).toBe('asc');
    });
    fireEvent.change(within(source).getByLabelText('並べ替えの向き'), {
      target: { value: 'desc' },
    });
    await waitFor(() => {
      expect(observationCalls().at(-1)?.query.get('direction')).toBe('desc');
    });
    fireEvent.change(within(source).getByLabelText('並べ替え', { selector: 'select' }), {
      target: { value: 'unknown-key' },
    });
    // 一覧にない並べ替えの指定は、無視する（直前の条件のまま）
    expect(observationCalls().at(-1)?.query.get('sort')).toBe('value');
  });

  describe('並べ替え（値・カテゴリ）・キーワード検索の期間は、診断期間の終了から 31 日以内（#91）', () => {
    const ninetyDays = () => {
      const long = diagnosis({ evaluatedFrom: '2026-07-11T03:00:00.000Z', periodDays: 90 });
      return jsonResponse(detail({ long, selected: long, periodDays: 90 }));
    };
    const observationCalls = (calls: { path: string; query: URLSearchParams }[]) =>
      calls.filter((call) => call.path === '/observations');

    it('診断期間が 31 日を超えるとき、既定（日時順・キーワードなし）は、診断期間の全体で取得し、案内は出さない', async () => {
      const { calls } = renderPath('/viewpoints/environmentalAdaptability', { detail: ninetyDays });
      const source = await screen.findByTestId('source-data');
      await within(source).findByText('27.5℃');

      expect(observationCalls(calls)[0]?.query.get('from')).toBe('2026-07-11T03:00:00.000Z');
      expect(observationCalls(calls)[0]?.query.get('to')).toBe('2026-10-09T03:00:00.000Z');
      expect(within(source).queryByTestId('source-data-period-note')).toBeNull();
    });

    it.each([
      ['値の順', 'sort'],
      ['キーワード', 'keyword'],
    ])(
      '診断期間が 31 日を超えるとき、%s を使うと、終了から 31 日分に絞って取得し、その旨を示す。戻すと、診断期間の全体に戻る',
      async (_name, kind) => {
        const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
          detail: ninetyDays,
        });
        const source = await screen.findByTestId('source-data');
        await within(source).findByText('27.5℃');

        if (kind === 'sort') {
          fireEvent.change(within(source).getByLabelText('並べ替え', { selector: 'select' }), {
            target: { value: 'value' },
          });
        } else {
          fireEvent.change(within(source).getByLabelText('キーワード'), {
            target: { value: '温度' },
          });
        }

        await waitFor(() => {
          expect(observationCalls(calls).at(-1)?.query.get('from')).toBe(
            '2026-09-08T03:00:00.000Z',
          );
        });
        expect(observationCalls(calls).at(-1)?.query.get('to')).toBe('2026-10-09T03:00:00.000Z');
        expect(within(source).getByTestId('source-data-period-note').textContent).toBe(
          '並べ替え・検索の対象は、診断期間のうち、終了日時から 31 日分です',
        );

        if (kind === 'sort') {
          fireEvent.change(within(source).getByLabelText('並べ替え', { selector: 'select' }), {
            target: { value: 'observedAt' },
          });
        } else {
          fireEvent.change(within(source).getByLabelText('キーワード'), { target: { value: '' } });
        }
        await waitFor(() => {
          expect(observationCalls(calls).at(-1)?.query.get('from')).toBe(
            '2026-07-11T03:00:00.000Z',
          );
        });
        expect(within(source).queryByTestId('source-data-period-note')).toBeNull();
      },
    );

    it('診断期間が 31 日以内なら、並べ替え・キーワードを使っても、診断期間のまま取得し、案内は出さない', async () => {
      const { calls } = renderPath('/viewpoints/environmentalAdaptability');
      const source = await screen.findByTestId('source-data');
      await within(source).findByText('27.5℃');

      fireEvent.change(within(source).getByLabelText('並べ替え', { selector: 'select' }), {
        target: { value: 'value' },
      });

      await waitFor(() => {
        expect(observationCalls(calls).at(-1)?.query.get('sort')).toBe('value');
      });
      expect(observationCalls(calls).at(-1)?.query.get('from')).toBe('2026-10-02T03:00:00.000Z');
      expect(within(source).queryByTestId('source-data-period-note')).toBeNull();
    });

    it('評価がまだなく、診断期間がないときは、キーワード・値・カテゴリの順を使えない（案内を示す）。日時順は使える', async () => {
      const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
        detail: () =>
          jsonResponse(detail({ isEvaluated: false, selected: null, short: null, long: null })),
      });
      const source = await screen.findByTestId('source-data');
      await waitFor(() => {
        expect(observationCalls(calls)).not.toHaveLength(0);
      });

      expect(within(source).getByLabelText<HTMLInputElement>('キーワード').disabled).toBe(true);
      expect(
        within(source).getByLabelText<HTMLSelectElement>('並べ替え', { selector: 'select' })
          .disabled,
      ).toBe(true);
      expect(within(source).getByTestId('source-data-period-guidance').textContent).toBe(
        '診断（評価）がまだないため、並べ替え・キーワード検索は使えません',
      );
      expect(observationCalls(calls).every((call) => call.query.get('sort') === 'observedAt')).toBe(
        true,
      );
    });
  });

  it('ページ分割: 次へ・前へで、カーソルを進め・戻す。先頭では前へ、最後では次へを無効にする', async () => {
    const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
      observations: (request) =>
        jsonResponse(
          observationList({
            nextCursor: request.query.get('cursor') === null ? 'cursor-2' : null,
          }),
        ),
    });
    const source = await screen.findByTestId('source-data');
    await within(source).findByText('27.5℃');
    const previous = within(source).getByRole<HTMLButtonElement>('button', { name: '前へ' });
    const next = within(source).getByRole<HTMLButtonElement>('button', { name: '次へ' });
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(within(source).getByTestId('source-data-page').textContent).toBe('1');

    fireEvent.click(next);
    await waitFor(() => {
      expect(within(source).getByTestId('source-data-page').textContent).toBe('2');
    });
    await waitFor(() => {
      expect(
        calls
          .filter((call) => call.path === '/observations')
          .at(-1)
          ?.query.get('cursor'),
      ).toBe('cursor-2');
    });
    await within(source).findByText('27.5℃');
    expect(within(source).getByRole<HTMLButtonElement>('button', { name: '次へ' }).disabled).toBe(
      true,
    );

    fireEvent.click(within(source).getByRole('button', { name: '前へ' }));
    await waitFor(() => {
      expect(within(source).getByTestId('source-data-page').textContent).toBe('1');
    });
  });

  it('該当するデータがなければ、その旨を示す', async () => {
    renderPath('/viewpoints/environmentalAdaptability', {
      observations: () => jsonResponse(observationList({ items: [] })),
    });

    const source = await screen.findByTestId('source-data');

    expect((await within(source).findByTestId('source-data-empty')).textContent).toContain(
      '該当するデータがありません',
    );
  });

  it('取得に失敗したら、エラーと再読み込みを示し、再読み込みで取得し直す', async () => {
    let failing = true;
    const { calls } = renderPath('/viewpoints/environmentalAdaptability', {
      observations: () =>
        failing
          ? errorResponse(500, 'INTERNAL_ERROR', '元データを取得できません')
          : jsonResponse(observationList()),
    });
    const source = await screen.findByTestId('source-data');
    const alert = await within(source).findByRole('alert');
    expect(alert.textContent).toContain('元データを取得できません');

    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: '再読み込み' }));

    await within(source).findByText('27.5℃');
    expect(calls.filter((call) => call.path === '/observations').length).toBeGreaterThan(1);
  });
});

describe('満足度の詳細（UC-21。SC-04）', () => {
  const FULL = [5, 4, 3, 4, 5, 4, 3, 4, 5];

  it('総合満足度・判定・判断基準（4.0以上 正常 など）・レーダーチャート・観点ごとのスターを表示する', async () => {
    renderPath('/satisfaction', { detail: () => jsonResponse(satisfactionDetail(FULL)) });

    const overall = await screen.findByTestId('overall');

    expect(within(overall).getByTestId('overall-score').textContent).toBe('4.1');
    expect(within(overall).getAllByText('正常').length).toBeGreaterThan(0);
    const criteria = within(overall).getByRole('list', { name: '判断基準' });
    expect(criteria.textContent).toContain('4.0以上');
    expect(criteria.textContent).toContain('3.0以上4.0未満');
    expect(criteria.textContent).toContain('3.0未満');
    expect(within(overall).queryByTestId('satisfaction-missing')).toBeNull();

    const radar = screen.getByTestId('radar');
    expect(radar.querySelector('svg.radar-chart')).not.toBeNull();
    expect(radar.querySelectorAll('circle.radar-dot')).toHaveLength(9);
    // 画面での呼び方（用語集）: 表の列見出しは「指標」「値」（「メトリクス」と書かない）
    expect(
      within(radar)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['指標', '値']);
    expect(radar.textContent).not.toContain('メトリクス');
    expect(within(radar).getByTestId('score-harvestAccuracy').textContent).toContain('★★★★★');
    expect(within(radar).getByTestId('score-environmentalAdaptability').textContent).toContain(
      '★★★☆☆',
    );
    expect(
      within(radar)
        .getByTestId('score-harvestAccuracy')
        .querySelector('[role="img"]')
        ?.getAttribute('aria-label'),
    ).toBe('5 / 5');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('満足度の詳細');
  });

  it('総合満足度の判断基準の状態（既定値）と、判断基準の編集への入口を示す（Issue #359）。入口は、満足度の判断基準の編集（他の観点と同じ画面）へ', async () => {
    renderPath('/satisfaction', { detail: () => jsonResponse(satisfactionDetail(FULL)) });

    const overall = await screen.findByTestId('overall');

    expect(within(overall).getByTestId('criteria-state').textContent).toBe('既定値');
    expect(within(overall).getByRole('link', { name: '判断基準を編集' }).getAttribute('href')).toBe(
      '/viewpoints/satisfaction/criteria',
    );
  });

  it('総合満足度の判断基準を変更しているときは、変更済み（版）と示し、変更後の閾値を、判断基準の一覧に示す（Issue #359）', async () => {
    const changed = {
      ...getDefaultCriteria('satisfaction'),
      version: 'V3',
      isDefault: false,
      criteria: [
        {
          indicator: 'overallSatisfaction',
          kind: 'LOWER' as const,
          label: '総合満足度',
          thresholds: { errorBelow: 2.5, cautionBelow: 3.5 },
        },
      ],
    };
    renderPath('/satisfaction', {
      detail: () => jsonResponse(satisfactionDetail(FULL, { criteria: changed })),
    });

    const overall = await screen.findByTestId('overall');

    expect(within(overall).getByTestId('criteria-state').textContent).toBe('変更済み（版: V3）');
    const criteria = within(overall).getByRole('list', { name: '判断基準' });
    expect(criteria.textContent).toContain('3.5以上');
    expect(criteria.textContent).toContain('2.5以上3.5未満');
    expect(criteria.textContent).toContain('2.5未満');
  });

  it('9観点のいずれかが未入力なら、不明とし、未入力の観点を挙げて、データ入力へ促す', async () => {
    renderPath('/satisfaction', {
      detail: () => jsonResponse(satisfactionDetail([5, 4, 3, null, 5, 4, 3, 4, null])),
    });

    const missing = await screen.findByTestId('satisfaction-missing');

    expect(missing.textContent).toContain('操作性、耐久性');
    expect(within(missing).getByRole('link', { name: 'データ入力へ' }).getAttribute('href')).toBe(
      '/data-entry',
    );
    expect(screen.getByTestId('overall-score').textContent).toBe('—');
    expect(within(screen.getByTestId('overall')).getAllByText('不明').length).toBeGreaterThan(0);
    expect(screen.getByTestId('score-operability').textContent).toContain('未入力');
    expect(screen.getByTestId('radar').querySelectorAll('circle.radar-dot')).toHaveLength(7);
  });

  it('評価がまだなら、その旨を示す', async () => {
    renderPath('/satisfaction', {
      detail: () =>
        jsonResponse(
          satisfactionDetail([null, null, null, null, null, null, null, null, null], {
            isEvaluated: false,
            selected: null,
            long: null,
          }),
        ),
    });

    const overall = await screen.findByTestId('overall');

    expect(overall.textContent).toContain('まだ評価されていません');
    expect(screen.getByTestId('satisfaction-missing').textContent).toContain('収穫精度');
  });

  it('期間を選んでいないときは、満足度の既定の期間（30 日）で取得し、期間の選択も 30 日を示す', async () => {
    const { calls } = renderPath('/satisfaction', {
      detail: () => jsonResponse(satisfactionDetail(FULL)),
    });
    await screen.findByTestId('overall');

    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('30');
    expect(
      calls.find((call) => call.path === '/viewpoints/satisfaction')?.query.get('periodDays'),
    ).toBe('30');
  });

  it('期間を選ぶと（30 日以外も）、他の観点と同じ長期の期間（当日・7・30・60・90 日）から選べ、選んだ期間で取得する', async () => {
    const { calls } = renderPath('/satisfaction', {
      detail: () => jsonResponse(satisfactionDetail(FULL)),
    });
    await screen.findByTestId('overall');

    expect(
      [...screen.getByLabelText<HTMLSelectElement>('長期の期間').options].map(
        (option) => option.value,
      ),
    ).toEqual(['1', '7', '30', '60', '90']);
    fireEvent.change(screen.getByLabelText('長期の期間'), { target: { value: '7' } });

    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=LONG&periodDays=7');
    });
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/viewpoints/satisfaction').at(-1);
      expect(last?.query.get('periodDays')).toBe('7');
    });
    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('7');
  });

  it('URL に期間があれば（7 日など）、その期間で取得する', async () => {
    const { calls } = renderPath('/satisfaction?periodDays=7', {
      detail: () => jsonResponse(satisfactionDetail(FULL)),
    });
    await screen.findByTestId('overall');

    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('7');
    expect(
      calls.find((call) => call.path === '/viewpoints/satisfaction')?.query.get('periodDays'),
    ).toBe('7');
  });

  it('期間を選ぶと、その期間で取得し直す。URL のクエリで保持する', async () => {
    const { calls } = renderPath('/satisfaction?periodDays=30', {
      detail: () => jsonResponse(satisfactionDetail(FULL)),
    });
    await screen.findByTestId('overall');

    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('30');
    expect(screen.queryByRole('radio', { name: '短期' })).toBeNull();
    fireEvent.change(screen.getByLabelText('長期の期間'), { target: { value: '90' } });

    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=LONG&periodDays=90');
    });
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/viewpoints/satisfaction').at(-1);
      expect(last?.query.get('periodDays')).toBe('90');
      expect(last?.query.get('horizon')).toBe('LONG');
    });
  });

  it('「対象の設備」を、満足度の詳細の中で選べる（ページの中にある）', async () => {
    renderPath('/satisfaction');
    const select = await screen.findByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options).toHaveLength(3);
    });

    expect(select.value).toBe('HOUSE-01');
    expect(within(screen.getByRole('banner')).queryByLabelText('対象の設備')).toBeNull();
  });

  it('満足度を評価しない設備（ロボット）を選んだ場合は、その旨と、設備の選び直しを示す', async () => {
    renderPath('/satisfaction', {
      detail: () => errorResponse(404, 'NOT_FOUND', 'この設備では評価しない観点です'),
    });

    const message = await screen.findByTestId('not-applicable');

    expect(message.textContent).toContain('この設備では評価しない観点です');
    expect(message.textContent).toContain('設備を選び直してください');
  });

  it('その他のエラーは、エラーと再読み込みを示す。設備の階層のエラーも同様', async () => {
    const failed = renderPath('/satisfaction', {
      detail: () => errorResponse(500, 'INTERNAL_ERROR', '満足度を取得できません'),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('満足度を取得できません');
    failed.unmount();

    renderPath('/satisfaction', {
      equipment: () => errorResponse(500, 'INTERNAL_ERROR', '設備を取得できません'),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('設備を取得できません');
  });

  it('読み込み中は、見出しのみを示す', () => {
    renderPath('/satisfaction');

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('満足度の詳細');
  });
});

describe('判断基準の表の、狭い幅のカード（#151。SC-03）', () => {
  it('各セルが、同じ列の見出しを、カードの項目名（data-label）として持つ（指標の名前は、行の見出しで、題名になる）', async () => {
    renderPath('/viewpoints/environmentalAdaptability');
    await screen.findByTestId('criteria');

    expectCardLabels(within(screen.getByTestId('criteria')).getByRole('table'));
  });
});

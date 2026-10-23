/**
 * ダッシュボードの視点・期間・カード（UC-01・UC-04）、観点の詳細（UC-02・UC-03・UC-04。SC-03）、
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
import { expectCardLabels } from '../../support/card-table.ts';

interface Scenario {
  readonly dashboard?: (request: FakeRequest) => Response;
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

describe('ダッシュボード（UC-01・UC-04）', () => {
  it('視点・期間は URL のクエリで保持し、切り替えると、そのクエリで取得し直す', async () => {
    const { calls } = renderPath('/?horizon=SHORT&periodDays=30');

    expect(await screen.findByRole('heading', { name: '安全性' })).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '短期' }).checked).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('30');
    const first = calls.find((call) => call.path === '/dashboard');
    expect(first?.query.get('horizon')).toBe('SHORT');
    expect(first?.query.get('periodDays')).toBe('30');

    fireEvent.click(screen.getByRole('radio', { name: '長期' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=LONG&periodDays=30');
    });
    fireEvent.change(screen.getByLabelText('長期の期間'), { target: { value: '90' } });
    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=LONG&periodDays=90');
    });
    await waitFor(() => {
      expect(
        calls
          .filter((call) => call.path === '/dashboard')
          .at(-1)
          ?.query.get('periodDays'),
      ).toBe('90');
    });
  });

  it('不正なクエリは、既定値（長期・直近7日）として扱う', async () => {
    renderPath('/?horizon=MIDDLE&periodDays=5');

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByRole<HTMLInputElement>('radio', { name: '長期' }).checked).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('長期の期間').value).toBe('7');
  });

  it('対象の設備名と最終の評価日時を示す', async () => {
    renderPath('/');

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.getByText('ハウス1', { selector: 'strong' })).toBeDefined();
    expect(screen.getByText(/最終の評価: 2026\/10\/09 12:00:00/)).toBeDefined();
  });

  it('評価がまだなら、最終の評価日時を示さない', async () => {
    renderPath('/', {
      dashboard: () =>
        new Response(JSON.stringify({ ...dashboard(), evaluatedAt: null }), { status: 200 }),
    });

    await screen.findByRole('heading', { name: '安全性' });

    expect(screen.queryByText(/最終の評価/)).toBeNull();
  });

  it('カードの詳細へのリンクは、視点・期間を引き継ぐ。満足度は、満足度の詳細（期間のみ）へ', async () => {
    renderPath('/?horizon=SHORT&periodDays=60');

    const safety = (await screen.findByRole('heading', { name: '安全性' })).closest('li');
    const satisfaction = screen.getByRole('heading', { name: '満足度' }).closest('li');
    if (safety === null || satisfaction === null) {
      throw new Error('テストの前提: カードがある');
    }

    expect(
      within(safety)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/viewpoints/safety?horizon=SHORT&periodDays=60',
      '/viewpoints/safety?horizon=SHORT&periodDays=60',
    ]);
    expect(within(satisfaction).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      '/satisfaction?periodDays=60',
    );
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

    const element = (await screen.findByRole('heading', { name: '安全性' })).closest('li');
    if (element === null) {
      throw new Error('テストの前提: カードがある');
    }

    const emergency = within(element).getByText('0.030回/時間').closest('dd');
    expect(emergency?.className).toContain('metric-caution');
    expect(emergency?.textContent).toContain('注意');
    const nearMiss = within(element).getByText('—').closest('dd');
    expect(nearMiss?.className).toContain('metric-none');
    const status = within(element).getByText('転倒（姿勢異常）').closest('dd');
    expect(status?.className).toContain('metric-error');
    expect(status?.textContent).toContain('異常');
  });

  it('短期評価を持たない観点を短期で表示している場合は、長期の結果を表示している旨を示す。評価前のカードには示さない', async () => {
    renderPath('/?horizon=SHORT', {
      dashboard: () =>
        jsonResponse(
          dashboard({
            viewpoints: [
              card({ viewpointId: 'durability', name: '耐久性', horizonUsed: 'LONG' }),
              card({
                viewpointId: 'satisfaction',
                name: '満足度',
                status: 'UNKNOWN',
                evaluatedFrom: null,
                evaluatedTo: null,
                horizonUsed: 'LONG',
              }),
              card({ viewpointId: 'safety', name: '安全性', horizonUsed: 'SHORT' }),
            ],
          }),
        ),
    });

    await screen.findByRole('heading', { name: '耐久性' });

    expect(
      screen.getAllByText('この観点は短期評価を持たないため、長期の結果を表示しています'),
    ).toHaveLength(1);
  });

  it('データが未取得なら、その旨と、データ入力・取り込み設定への導線を示す。古い場合は警告', async () => {
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
    expect(
      within(notice).getByRole('link', { name: '取り込み設定・状況へ' }).getAttribute('href'),
    ).toBe('/settings/ingestion');
    // ヘッダーの表示は、ダッシュボードの描画後の効果で更新されるため、現れるまで待つ
    expect(await screen.findByText('未取得')).toBeDefined();
    none.unmount();

    renderPath('/', { dashboard: () => jsonResponse(dashboard({ dataFreshness: 'STALE' })) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('データが古くなっています');
    expect(await screen.findByText('（古い）')).toBeDefined();
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
    expect(screen.getByText('ハウス1', { selector: 'strong' })).toBeDefined();
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
      'ステータスコード管理',
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
    expect(within(guide).getByRole('link', { name: '取り込み設定・状況へ' })).toBeDefined();
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
    expect(
      within(guide).getByRole('link', { name: '取り込み設定・状況へ' }).getAttribute('href'),
    ).toBe('/settings/ingestion');
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

  it('ダッシュボードへ戻るリンクは、視点・期間を引き継ぐ', async () => {
    renderPath('/viewpoints/environmentalAdaptability?horizon=SHORT&periodDays=30');

    const breadcrumb = await screen.findByRole('navigation', { name: 'パンくず' });
    const link = within(breadcrumb).getByRole('link', { name: 'ダッシュボード' });

    expect(link.getAttribute('href')).toBe('/?horizon=SHORT&periodDays=30');
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

/**
 * 評価しない設備を選んでいるときの案内（Issue #156。SC-03-1・SC-04-6。SC-03・SC-04）の単体テスト。
 * 観点の詳細・満足度の詳細（全画面のページ・ダッシュボードのドロワー）で、ロボット・センサーに評価しない観点を開いたとき、
 * エラーの見た目（`role="alert"`）ではなく、中立の案内（`role="status"`）を示し、親のハウスへ切り替えるボタンを付ける。API はスタブ（tests/support）。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/frontend/app.tsx';
import {
  WORKER_LOGIN,
  createFakeFetch,
  createMemorySession,
  dashboard,
  equipmentTree,
  errorResponse,
  jsonResponse,
  twoFacilityTree,
  type FakeHandler,
  type FakeRequest,
} from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';
import {
  detail,
  observationList,
  satisfactionDetail,
  series,
} from '../../support/viewpoint-fixtures.ts';

const NOT_APPLICABLE_MESSAGE = 'この設備では評価しない観点です';

interface Options {
  /** 設備の階層（既定: ハウス 1 つ）。 */
  readonly tree?: () => Response;
  /** true なら、ハウスを選んでいても、観点の詳細は NOT_FOUND（存在しない観点などの場合）。 */
  readonly alwaysNotFound?: boolean;
}

/** ハウス（HOUSE-…）だけ、観点の詳細を返す。ロボット・センサーは、評価しない（NOT_FOUND）。 */
function handlerOf(options: Options): FakeHandler {
  const base = withBaseRoutes({
    'GET /equipment': options.tree ?? (() => jsonResponse(equipmentTree())),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /observations': () => jsonResponse(observationList()),
  });
  return (request: FakeRequest) => {
    if (request.path.endsWith('/series')) {
      return jsonResponse(series());
    }
    if (request.path.startsWith('/viewpoints/')) {
      const equipmentId = request.query.get('equipmentId') ?? '';
      if (options.alwaysNotFound === true || !equipmentId.startsWith('HOUSE')) {
        return errorResponse(404, 'NOT_FOUND', NOT_APPLICABLE_MESSAGE);
      }
      return request.path === '/viewpoints/satisfaction'
        ? jsonResponse(satisfactionDetail([4, 4, 4, 4, 4, 4, 4, 4, 4]))
        : jsonResponse(detail());
    }
    return base(request);
  };
}

function renderPath(path: string, options: Options = {}) {
  window.history.pushState(null, '', path);
  const fake = createFakeFetch(handlerOf(options));
  return render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fake.fetchFn} />);
}

/** 対象の設備（ページの中）を選ぶ。選択肢が読み込まれるのを待つ。 */
async function selectEquipment(scope: HTMLElement, equipmentId: string): Promise<void> {
  const select = await within(scope).findByLabelText<HTMLSelectElement>('対象の設備');
  await waitFor(() => {
    expect(select.options.length).toBeGreaterThan(1);
  });
  fireEvent.change(select, { target: { value: equipmentId } });
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('評価しない設備の案内: 満足度の詳細（SC-04-6）', () => {
  it('ロボットを選ぶと、エラーではなく案内（role=status）を示し、ハウスの評価である旨を伝える', async () => {
    renderPath('/satisfaction');
    await screen.findByTestId('overall-score');

    await selectEquipment(screen.getByRole('main'), 'ROBOT-01');

    const notice = await screen.findByTestId('not-applicable');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).not.toContain('state-error');
    expect(notice.textContent).toContain(NOT_APPLICABLE_MESSAGE);
    expect(notice.textContent).toContain('この観点（満足度）は、ハウスの評価です');
    expect(notice.textContent).toContain('ロボットでは評価しません');
    // 案内は、警告ではない（読み上げの割り込みをしない）
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('「ハウス『ハウス1』を表示」を押すと、選択が親のハウスに切り替わり、満足度を表示する', async () => {
    renderPath('/satisfaction');
    await screen.findByTestId('overall-score');
    await selectEquipment(screen.getByRole('main'), 'ROBOT-01');
    const notice = await screen.findByTestId('not-applicable');

    fireEvent.click(within(notice).getByRole('button', { name: 'ハウス「ハウス1」を表示' }));

    await screen.findByTestId('overall-score');
    expect(screen.queryByTestId('not-applicable')).toBeNull();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '対象の設備' }).value).toBe(
      'HOUSE-01',
    );
  });

  it('ハウスが複数あるとき、選んでいる設備の親のハウスへ切り替える', async () => {
    renderPath('/satisfaction', { tree: () => jsonResponse(twoFacilityTree()) });
    await screen.findByTestId('overall-score');
    await selectEquipment(screen.getByRole('main'), 'ROBOT-02');
    const notice = await screen.findByTestId('not-applicable');

    expect(within(notice).queryByRole('button', { name: 'ハウス「ハウス1」を表示' })).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'ハウス「ハウス2」を表示' }));

    await screen.findByTestId('overall-score');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '対象の設備' }).value).toBe(
      'HOUSE-02',
    );
  });
});

describe('評価しない設備の案内: 観点の詳細（SC-03-1）', () => {
  it('センサーにロボットの観点を開くと、案内（role=status）と、観点の名称・親のハウスへの切り替えを示す', async () => {
    renderPath('/viewpoints/harvestAccuracy');
    await screen.findByTestId('diagnosis');

    await selectEquipment(screen.getByRole('main'), 'SENSOR-01');

    const notice = await screen.findByTestId('not-applicable');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain(NOT_APPLICABLE_MESSAGE);
    expect(notice.textContent).toContain('この観点（収穫精度）は、ハウスの評価です');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(within(notice).getByRole('button', { name: 'ハウス「ハウス1」を表示' }));

    await screen.findByTestId('diagnosis');
    expect(screen.queryByTestId('not-applicable')).toBeNull();
  });

  it('ハウスを選んでいて、観点が見つからないとき（切り替え先がない）は、ボタンを出さず、設備の選び直しを案内する', async () => {
    renderPath('/viewpoints/harvestAccuracy', { alwaysNotFound: true });

    const notice = await screen.findByTestId('not-applicable');

    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain(NOT_APPLICABLE_MESSAGE);
    expect(notice.textContent).toContain('ハウスまたは対象の設備を選び直してください');
    expect(within(notice).queryByRole('button')).toBeNull();
  });
});

describe('評価しない設備の案内: ダッシュボードのドロワー', () => {
  it('ドロワーの中で、ロボットを選んだときも、同じ案内を示し、ハウスへ切り替えられる', async () => {
    renderPath('/?viewpoint=satisfaction');
    const dialog = await screen.findByRole('dialog', { name: '満足度の詳細' });
    await within(dialog).findByTestId('overall-score');

    await selectEquipment(dialog, 'ROBOT-01');

    const notice = await within(dialog).findByTestId('not-applicable');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('この観点（満足度）は、ハウスの評価です');
    fireEvent.click(within(notice).getByRole('button', { name: 'ハウス「ハウス1」を表示' }));

    await within(dialog).findByTestId('overall-score');
    expect(within(dialog).queryByTestId('not-applicable')).toBeNull();
  });
});

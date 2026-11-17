/**
 * ダッシュボードから開く、観点の詳細の右からのドロワー（Issue #357。UC-01・UC-02。SC-02・SC-03・SC-04）の単体テスト。
 * 開く（カード・観点別の状態の表）・URL（`/?viewpoint=観点`）・閉じる（✕・Esc・背面・戻る）・フォーカス・ダッシュボードの保持・
 * ドロワーの中の操作（期間・視点・対象の設備）を確認する。API はスタブ（tests/support）。
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

function handler(options: { equipment?: () => Response } = {}): FakeHandler {
  const base = withBaseRoutes({
    'GET /equipment': options.equipment ?? (() => jsonResponse(equipmentTree())),
    'GET /dashboard': () => jsonResponse(dashboard()),
    'GET /observations': () => jsonResponse(observationList()),
  });
  return (request) => {
    if (request.path.endsWith('/series')) {
      return jsonResponse(series());
    }
    if (request.path === '/viewpoints/satisfaction') {
      return jsonResponse(satisfactionDetail([5, 4, 3, 4, 5, 4, 3, 4, 5]));
    }
    if (request.path.startsWith('/viewpoints/')) {
      return jsonResponse(detail());
    }
    return base(request);
  };
}

function renderPath(path: string, options: { equipment?: () => Response } = {}) {
  window.history.pushState(null, '', path);
  const fake = createFakeFetch(handler(options));
  const view = render(<App session={createMemorySession(WORKER_LOGIN)} fetchFn={fake.fetchFn} />);
  return { ...fake, ...view };
}

const dashboardCalls = (calls: readonly FakeRequest[]) =>
  calls.filter((call) => call.path === '/dashboard');
const detailCalls = (calls: readonly FakeRequest[], id = 'safety') =>
  calls.filter((call) => call.path === `/viewpoints/${id}`);

/** ダッシュボードのカードの題名のリンク。 */
function cardLink(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name, level: 3 }).closest('li');
  if (card === null) {
    throw new Error('テストの前提: カードがある');
  }
  const [link] = within(card).getAllByRole('link');
  if (link === undefined) {
    throw new Error('テストの前提: カードのリンクがある');
  }
  return link;
}

async function openDrawer(name = '安全性'): Promise<HTMLElement> {
  const link = cardLink(name);
  link.focus();
  fireEvent.click(link);
  return screen.findByRole('dialog', { name: `${name}の詳細` });
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

describe('観点の詳細のドロワー: 開く', () => {
  it('カードを選ぶと、観点の詳細が、右からのドロワー（ダイアログ）に開く。URL は、ダッシュボードに観点を付けたもの（ページ遷移はしない）', async () => {
    const { calls } = renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });

    const dialog = await openDrawer();

    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?viewpoint=safety');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(await within(dialog).findByTestId('diagnosis')).toBeDefined();
    expect(detailCalls(calls)).not.toHaveLength(0);
  });

  it('観点別の状態の表の行を選んでも、同じドロワーが開く。満足度は、満足度の詳細がドロワーに開く', async () => {
    renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });

    fireEvent.click(within(screen.getByTestId('status-row-safety')).getByRole('link'));
    const safety = await screen.findByRole('dialog', { name: '安全性の詳細' });
    expect(safety).toBeDefined();
    fireEvent.click(within(safety).getByRole('button', { name: '観点の詳細を閉じる' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(cardLink('満足度'));
    const satisfaction = await screen.findByRole('dialog', { name: '満足度の詳細' });

    expect(window.location.search).toBe('?viewpoint=satisfaction');
    expect(
      await within(satisfaction).findByRole('heading', { level: 2, name: /満足度の詳細/ }),
    ).toBeDefined();
  });

  it('ダッシュボードは、描画したまま保つ（作り直さない）。ドロワーの見出しは h2（ページの h1 は、ダッシュボード）', async () => {
    renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    const before = screen.getByTestId('card-safety');

    const dialog = await openDrawer();

    expect(screen.getByTestId('card-safety')).toBe(before);
    expect(screen.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeDefined();
    expect(within(dialog).queryByRole('heading', { level: 1 })).toBeNull();
    expect(
      await within(dialog).findByRole('heading', { level: 2, name: /環境適応性/ }),
    ).toBeDefined();
    // パンくずは、出さない（閉じる操作は、ドロワーが持つ）
    expect(within(dialog).queryByRole('navigation', { name: 'パンくず' })).toBeNull();
  });

  it('URL に観点があれば（再読み込み・共有）、最初から開く。知らない観点は、無視する', async () => {
    const first = renderPath('/?viewpoint=satisfaction&periodDays=7');

    expect(await screen.findByRole('dialog', { name: '満足度の詳細' })).toBeDefined();
    first.unmount();

    renderPath('/?viewpoint=unknown');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('開いている間は、本文のスクロールを固定する（drawer-open）。閉じると、外す', async () => {
    renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    expect(document.body.classList.contains('drawer-open')).toBe(false);

    const dialog = await openDrawer();
    expect(document.body.classList.contains('drawer-open')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '観点の詳細を閉じる' }));
    await waitFor(() => {
      expect(document.body.classList.contains('drawer-open')).toBe(false);
    });
  });

  it('「ページで開く」は、全画面のページへ移る（視点・期間を引き継ぐ。満足度は、満足度の詳細へ）', async () => {
    const first = renderPath('/?periodDays=60');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    const safety = await openDrawer();

    expect(within(safety).getByRole('link', { name: 'ページで開く' }).getAttribute('href')).toBe(
      '/viewpoints/safety?horizon=LONG&periodDays=60',
    );
    first.unmount();

    renderPath('/?viewpoint=satisfaction&periodDays=60');
    const satisfaction = await screen.findByRole('dialog', { name: '満足度の詳細' });
    expect(
      within(satisfaction).getByRole('link', { name: 'ページで開く' }).getAttribute('href'),
    ).toBe('/satisfaction?periodDays=60');
  });

  it('期間を選んでいないとき、「ページで開く」は、観点の既定の期間（7 日。満足度は 30 日）を付ける', async () => {
    renderPath('/?viewpoint=safety');

    const dialog = await screen.findByRole('dialog', { name: '安全性の詳細' });

    expect(within(dialog).getByRole('link', { name: 'ページで開く' }).getAttribute('href')).toBe(
      '/viewpoints/safety?horizon=LONG&periodDays=7',
    );
  });
});

describe('観点の詳細のドロワー: 閉じる', () => {
  it.each([
    [
      '✕',
      async (dialog: HTMLElement) => {
        fireEvent.click(within(dialog).getByRole('button', { name: '観点の詳細を閉じる' }));
        await Promise.resolve();
      },
    ],
    [
      'Esc',
      async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
        await Promise.resolve();
      },
    ],
    [
      '背面（スクリーン）',
      async () => {
        const scrim = document.querySelector('.drawer-scrim');
        if (scrim === null) {
          throw new Error('テストの前提: スクリーンがある');
        }
        fireEvent.click(scrim);
        await Promise.resolve();
      },
    ],
  ])(
    '%s で閉じる。URL から観点が外れ、開いたカードのリンクに、フォーカスが戻る。ダッシュボードの期間は、保たれる',
    async (_name, close) => {
      renderPath('/?periodDays=30');
      await screen.findByRole('heading', { name: '安全性', level: 3 });
      const link = cardLink('安全性');
      const dialog = await openDrawer();

      await close(dialog);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(window.location.search).toBe('?periodDays=30');
      expect(document.activeElement).toBe(link);
    },
  );

  it('ブラウザの「戻る」で閉じる（開くときに、履歴を積むため）', async () => {
    renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    await openDrawer();
    expect(window.location.search).toBe('?viewpoint=safety');

    window.history.back();

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(window.location.search).toBe('');
  });
});

describe('観点の詳細のドロワー: フォーカスと、ドロワーの中の操作', () => {
  it('開くと、閉じるボタンにフォーカスがある。Tab の移動は、ドロワーの中に閉じ込める（最後の次は最初、最初の前は最後）', async () => {
    renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    const dialog = await openDrawer();
    const close = within(dialog).getByRole('button', { name: '観点の詳細を閉じる' });
    await waitFor(() => {
      expect(document.activeElement).toBe(close);
    });
    await within(dialog).findByTestId('diagnosis');
    const items = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary',
      ),
    );
    const first = items.at(0);
    const last = items.at(-1);

    last?.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first?.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('ドロワーの中で、期間・視点を切り替えても、ドロワーは開いたまま（URL の観点を保つ）。期間は、ダッシュボードの期間でもある', async () => {
    const { calls } = renderPath('/');
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    const dialog = await openDrawer();
    await within(dialog).findByTestId('diagnosis');

    fireEvent.change(within(dialog).getByLabelText('長期の期間'), { target: { value: '30' } });

    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=LONG&periodDays=30&viewpoint=safety');
    });
    expect(screen.getByRole('dialog', { name: '安全性の詳細' })).toBeDefined();
    await waitFor(() => {
      expect(dashboardCalls(calls).at(-1)?.query.get('periodDays')).toBe('30');
      expect(detailCalls(calls).at(-1)?.query.get('periodDays')).toBe('30');
    });

    fireEvent.click(within(dialog).getByRole('radio', { name: '短期' }));

    await waitFor(() => {
      expect(window.location.search).toBe('?horizon=SHORT&periodDays=30&viewpoint=safety');
    });
    await waitFor(() => {
      expect(detailCalls(calls).at(-1)?.query.get('horizon')).toBe('SHORT');
    });
    expect(screen.getByRole('dialog', { name: '安全性の詳細' })).toBeDefined();

    // 閉じると、視点は外れ、期間だけが残る
    fireEvent.click(within(dialog).getByRole('button', { name: '観点の詳細を閉じる' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(window.location.search).toBe('?periodDays=30');
  });

  it('ドロワーの中で、ロボットを選んでも、選択は、ハウスに戻されない。閉じると、そのハウスにそろう', async () => {
    const { calls } = renderPath('/', { equipment: () => jsonResponse(twoFacilityTree()) });
    await screen.findByRole('heading', { name: '安全性', level: 3 });
    const dialog = await openDrawer();
    const select = within(dialog).getByLabelText<HTMLSelectElement>('対象の設備');
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(3);
    });

    fireEvent.change(select, { target: { value: 'ROBOT-02' } });

    await waitFor(() => {
      expect(detailCalls(calls).at(-1)?.query.get('equipmentId')).toBe('ROBOT-02');
    });
    // 背面のダッシュボードは、そのロボットのハウスのまま（ハウス単位）。選択は、ロボットのまま
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(select.value).toBe('ROBOT-02');

    fireEvent.click(within(dialog).getByRole('button', { name: '観点の詳細を閉じる' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('対象のハウス').value).toBe('HOUSE-02');
    });
    // 次に、別のカードを開くと、ロボットでなく、ハウスの詳細になる
    const reopened = await openDrawer('収穫速度');
    expect(within(reopened).getByLabelText<HTMLSelectElement>('対象の設備').value).toBe('HOUSE-02');
  });
});

describe('全画面のページ（従来どおり）', () => {
  it('直接 URL（/viewpoints/…）は、ドロワーでなく、全画面のページ（パンくず・h1）で開く', async () => {
    renderPath('/viewpoints/safety');

    expect(await screen.findByRole('heading', { level: 1, name: /環境適応性/ })).toBeDefined();
    expect(screen.getByRole('navigation', { name: 'パンくず' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

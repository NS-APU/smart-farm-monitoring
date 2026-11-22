/**
 * 一覧の共通部品（Issue #152 の PR1）の単体テスト。
 * - 絞り込みの枠（FilterPanel）: 適用中の条件の数・条件のクリア・狭い幅での折りたたみ
 * - ページ送り（Pager）の表示範囲（「21〜40 件目」。総件数・総ページは出さない）
 * - 設備の選択肢の表示（ハウスの下にロボット・センサーを字下げし、種別を付ける。SC-06-8・SC-07-8）
 * 各画面への適用は、list-filter-pages.test.tsx。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { equipmentOptionLabel } from '../../../src/frontend/components/equipment-options.ts';
import { FilterPanel } from '../../../src/frontend/components/filter-controls.tsx';
import { Pager } from '../../../src/frontend/components/form-controls.tsx';
import { renderApp } from '../../support/management-frontend.ts';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function pagerProps(overrides: Partial<Parameters<typeof Pager>[0]> = {}) {
  return {
    pageNumber: 1,
    hasPrevious: false,
    hasNext: true,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
}

describe('絞り込みの枠（FilterPanel）', () => {
  it('適用中の条件がなければ、条件の数を示さず、条件のクリアは選べない', () => {
    render(
      <FilterPanel activeCount={0} onClear={vi.fn()}>
        <p>項目</p>
      </FilterPanel>,
    );

    expect(screen.queryByTestId('filter-active-count')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '条件のクリア' }).disabled).toBe(
      true,
    );
  });

  it('適用中の条件があれば、その数を示し、条件のクリアで onClear を呼ぶ', () => {
    const onClear = vi.fn();
    render(
      <FilterPanel activeCount={3} onClear={onClear}>
        <p>項目</p>
      </FilterPanel>,
    );

    expect(screen.getByTestId('filter-active-count').textContent).toBe('適用中の条件 3 件');
    const clear = screen.getByRole<HTMLButtonElement>('button', { name: '条件のクリア' });
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('開閉のボタンは、閉じた状態から始まり、押すと、開く（aria-expanded・名前・枠の印が変わる）。項目は、閉じていても DOM に残る', () => {
    const { container } = render(
      <FilterPanel activeCount={0} onClear={vi.fn()}>
        <label>
          キーワード
          <input />
        </label>
      </FilterPanel>,
    );
    const toggle = screen.getByRole('button', { name: '絞り込みを開く' });
    const body = container.querySelector<HTMLElement>('.filter-body');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(body?.id);
    expect(container.querySelector('.filter-panel')?.getAttribute('data-open')).toBe('false');
    expect(screen.getByLabelText('キーワード')).toBeDefined();

    fireEvent.click(toggle);

    const opened = screen.getByRole('button', { name: '絞り込みを閉じる' });
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.filter-panel')?.getAttribute('data-open')).toBe('true');

    fireEvent.click(opened);
    expect(screen.getByRole('button', { name: '絞り込みを開く' })).toBeDefined();
  });

  it('項目の入れ物は、絞り込みの並び（filter-bar）のまま', () => {
    const { container } = render(
      <FilterPanel activeCount={0} onClear={vi.fn()}>
        <p>項目</p>
      </FilterPanel>,
    );

    expect(container.querySelector('.filter-bar.filter-body')?.textContent).toBe('項目');
  });
});

describe('ページ送り（Pager）の表示範囲', () => {
  it('ページの大きさと、このページの件数があれば、「21〜40 件目」の形で示す（2 ページ目・20 件）', () => {
    render(<Pager {...pagerProps({ pageNumber: 2, pageSize: 20, itemCount: 20 })} />);

    expect(screen.getByTestId('pager-range').textContent).toBe('21〜40 件目');
  });

  it('最後のページは、このページの件数までを示す（3 ページ目・7 件 → 41〜47 件目）', () => {
    render(
      <Pager {...pagerProps({ pageNumber: 3, pageSize: 20, itemCount: 7, hasNext: false })} />,
    );

    expect(screen.getByTestId('pager-range').textContent).toBe('41〜47 件目');
  });

  it('1 件だけのときも、「1〜1 件目」の形で示す', () => {
    render(<Pager {...pagerProps({ pageSize: 20, itemCount: 1, hasNext: false })} />);

    expect(screen.getByTestId('pager-range').textContent).toBe('1〜1 件目');
  });

  it('このページが 0 件、またはページの大きさ・件数を渡さないときは、範囲を示さない。総件数・総ページも示さない', () => {
    const { rerender, container } = render(<Pager {...pagerProps()} />);
    expect(screen.queryByTestId('pager-range')).toBeNull();

    rerender(<Pager {...pagerProps({ pageSize: 20, itemCount: 0 })} />);
    expect(screen.queryByTestId('pager-range')).toBeNull();

    rerender(<Pager {...pagerProps({ pageNumber: 2, pageSize: 20, itemCount: 20 })} />);
    expect(container.textContent).not.toMatch(/総|全 ?\d+ ?件|\/ ?\d+/);
  });

  it('ページの番号の要素（既存のテスト ID）と、前へ・次へは、そのまま', () => {
    render(<Pager {...pagerProps({ pageNumber: 2, pageSize: 20, itemCount: 20 })} />);

    expect(screen.getByTestId('pager-page').textContent).toBe('2');
    expect(screen.getByRole('button', { name: '前へ' })).toBeDefined();
    expect(screen.getByRole('button', { name: '次へ' })).toBeDefined();
  });
});

describe('設備の選択肢の表示（equipmentOptionLabel。SC-06-8・SC-07-8）', () => {
  const base = { name: '名前' };

  it('ハウスは、名称のまま（階層の先頭）', () => {
    expect(equipmentOptionLabel({ ...base, equipmentType: 'FACILITY' })).toBe('名前');
  });

  it('ロボット・センサーは、字下げし、種別（ロボット・センサー）を付ける。同名の設備を区別できる', () => {
    expect(equipmentOptionLabel({ ...base, equipmentType: 'ROBOT' })).toBe('　名前（ロボット）');
    expect(equipmentOptionLabel({ ...base, equipmentType: 'SENSOR' })).toBe('　名前（センサー）');
  });
});

describe('データ入力のフォーム（SC-06）への適用', () => {
  it('データ入力のフォームの設備の選択肢にも、種別を付ける（SC-06-8）', async () => {
    renderApp('/data-entry', {});
    const select = await screen.findByLabelText<HTMLSelectElement>('設備', { exact: false });

    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      '選択してください',
      'ハウス1',
      '　収穫ロボット1（ロボット）',
      '　環境センサー1（センサー）',
    ]);
  });
});

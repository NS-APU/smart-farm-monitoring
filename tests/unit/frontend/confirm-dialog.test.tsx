/**
 * 確認のダイアログ（ConfirmDialog。Issue #153）の、対象の項目（ラベルと値）と、影響の説明（注記）の単体テスト。
 * フォーカス・キーボード操作は、accessibility.test.tsx。
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from '../../../src/frontend/components/form-controls.tsx';
import { confirmDetailsOf, confirmNotesOf } from '../../support/management-frontend.ts';

const BASE = {
  title: '削除しますか',
  message: '元に戻す操作はありません',
  confirmLabel: '削除',
  onConfirm: () => undefined,
  onCancel: () => undefined,
} as const;

describe('確認のダイアログ: 対象の項目と影響の説明（#153）', () => {
  it('対象の項目（ラベルと値）を、渡した順に、定義リスト（dt・dd）で示す', () => {
    render(
      <ConfirmDialog
        {...BASE}
        details={[
          { label: 'コード値', value: 'CHARGING' },
          { label: '名称', value: '充電中' },
        ]}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(confirmDetailsOf(dialog)).toEqual({ コード値: 'CHARGING', 名称: '充電中' });
    expect(Array.from(dialog.querySelectorAll('dt')).map((node) => node.textContent)).toEqual([
      'コード値',
      '名称',
    ]);
  });

  it('影響の説明（注記）を、渡した順に、箇条書きで示す。説明（message）は、そのまま残る', () => {
    render(
      <ConfirmDialog {...BASE} notes={['次の評価から反映されます', '過去の評価は保持します']} />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(confirmNotesOf(dialog)).toEqual(['次の評価から反映されます', '過去の評価は保持します']);
    expect(within(dialog).getByText('元に戻す操作はありません')).toBeDefined();
  });

  it('対象の項目・注記を渡さない（または空）と、対象の項目も注記も表示しない（既存の使い方は、変わらない）', () => {
    const { rerender } = render(<ConfirmDialog {...BASE} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelector('.dialog-details')).toBeNull();
    expect(dialog.querySelector('.dialog-notes')).toBeNull();

    rerender(<ConfirmDialog {...BASE} details={[]} notes={[]} />);
    expect(dialog.querySelector('.dialog-details')).toBeNull();
    expect(dialog.querySelector('.dialog-notes')).toBeNull();
  });

  it('対象の項目・注記があっても、取り消し側（キャンセル）が先に並び、確認のボタンは、確認の文言で押せる', () => {
    render(
      <ConfirmDialog
        {...BASE}
        details={[{ label: '名称', value: '充電中' }]}
        notes={['次の評価から反映されます']}
      />,
    );

    const buttons = within(screen.getByRole('alertdialog')).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['キャンセル', '削除']);
  });
});

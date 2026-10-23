/**
 * 通知・エラー・成功の表示のアイコンの単体テスト（種類を、色だけでなく、形でも示す。NFR-7.2）。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Field,
  FormError,
  PermissionNotice,
} from '../../../src/frontend/components/form-controls.tsx';
import { ErrorView, LoadingView } from '../../../src/frontend/components/state-views.tsx';

describe('通知・エラーの表示のアイコン', () => {
  it('画面のエラーは、先頭に「異常」の形のアイコンを置き、文字と再読み込みの操作を残す', () => {
    render(<ErrorView error={new Error('x')} onRetry={() => undefined} />);

    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('state-error')).toBe(true);
    expect(alert.firstElementChild?.getAttribute('data-icon')).toBe('status-error');
    expect(screen.getByRole('button', { name: '再読み込み' })).not.toBeNull();
  });

  it('フォーム全体のエラーは、先頭にアイコンを置き、メッセージの文字は、そのまま', () => {
    render(<FormError message="保存できませんでした" />);

    const alert = screen.getByRole('alert');
    expect(alert.querySelector('[data-icon="status-error"]')).not.toBeNull();
    expect(alert.textContent).toBe('保存できませんでした');
  });

  it('入力欄のエラーは、先頭にアイコンを置き、項目のエラーの文字は、そのまま', () => {
    render(
      <Field name="userId" label="ユーザー ID" error="入力してください">
        {(control) => <input {...control} />}
      </Field>,
    );

    const message = screen.getByText('入力してください');
    expect(message.querySelector('[data-icon="status-error"]')).not.toBeNull();
    expect(message.textContent).toBe('入力してください');
  });

  it('権限の案内は、先頭に「案内」のアイコン（状態の 4 つの形とは別の形）を置く', () => {
    render(<PermissionNotice message="この操作は、管理者だけが行えます" />);

    const notice = screen.getByTestId('permission-notice');
    expect(notice.firstElementChild?.getAttribute('data-icon')).toBe('info');
    expect(notice.textContent).toBe('この操作は、管理者だけが行えます');
  });

  it('読み込み中の表示には、アイコンを置かない（動かない・待ちの表示は、文字だけ）', () => {
    render(<LoadingView />);

    expect(screen.getByRole('status').querySelector('svg')).toBeNull();
  });
});

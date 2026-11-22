/**
 * 結果の通知の部品（Issue #150 の方針 1。SC-06-3）の単体テスト。保存・修正・削除などの結果を、`role="status"` で読み上げ、
 * 表示されたとき（現れた・変わったとき）に、画面内へスクロールする。フォーカスは動かさない（操作できる要素を持たないため）。
 */

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultNotice } from '../../../src/frontend/components/result-notice.tsx';
import { useRevealOnChange } from '../../../src/frontend/hooks/use-reveal-on-change.ts';
import { restoreScrollIntoView, stubScrollIntoView } from '../../support/scroll-into-view.ts';

afterEach(() => {
  restoreScrollIntoView();
  vi.unstubAllGlobals();
});

describe('結果の通知（ResultNotice）', () => {
  it('成功は、role="status" の完了メッセージ（form-success）で、先頭に「正常」の形のアイコン、文字はそのまま', () => {
    render(<ResultNotice message="保存しました" testId="saved-notice" />);

    const notice = screen.getByRole('status');
    expect(notice.getAttribute('data-testid')).toBe('saved-notice');
    expect(notice.classList.contains('form-success')).toBe(true);
    expect(notice.querySelector('[data-icon="status-normal"]')).not.toBeNull();
    expect(notice.textContent).toBe('保存しました');
  });

  it('失敗（ok=false）は、role="status" のまま、form-error の見た目で、先頭に「異常」の形のアイコンを置く', () => {
    render(<ResultNotice message="接続できませんでした" ok={false} testId="failed-notice" />);

    const notice = screen.getByRole('status');
    expect(notice.classList.contains('form-error')).toBe(true);
    expect(notice.classList.contains('form-success')).toBe(false);
    expect(notice.querySelector('[data-icon="status-error"]')).not.toBeNull();
    expect(notice.textContent).toBe('接続できませんでした');
  });

  it('表示されたとき、その要素を、画面内へスクロールする（見えていれば動かない nearest）', () => {
    const scroll = stubScrollIntoView();

    render(<ResultNotice message="保存しました" testId="saved-notice" />);

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole('status'));
    expect(scroll.mock.calls[0]?.[0]).toEqual({ block: 'nearest', behavior: 'smooth' });
  });

  it('動きを減らす設定（prefers-reduced-motion）のときは、アニメーションしない', () => {
    const scroll = stubScrollIntoView();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    }));

    render(<ResultNotice message="保存しました" testId="saved-notice" />);

    expect(scroll.mock.calls[0]?.[0]).toEqual({ block: 'nearest', behavior: 'auto' });
  });

  it('フォーカスを動かさない（押したボタンのまま。通知は、フォーカスを受けない）', () => {
    stubScrollIntoView();
    const { rerender } = render(
      <>
        <button type="button">保存する</button>
        <ResultNotice message={undefined} testId="saved-notice" />
      </>,
    );
    const button = screen.getByRole('button', { name: '保存する' });
    button.focus();

    rerender(
      <>
        <button type="button">保存する</button>
        <ResultNotice message="保存しました" testId="saved-notice" />
      </>,
    );

    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('status').hasAttribute('tabindex')).toBe(false);
  });

  it('メッセージが変わったときは、もう一度スクロールする。同じメッセージのまま描き直しても、スクロールしない', () => {
    const scroll = stubScrollIntoView();
    const { rerender } = render(<ResultNotice message="修正しました" testId="n" />);
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(<ResultNotice message="修正しました" testId="n" />);
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(<ResultNotice message="削除しました" testId="n" />);
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('メッセージがないときは、何も表示せず、スクロールもしない', () => {
    const scroll = stubScrollIntoView();

    const { container } = render(<ResultNotice message={undefined} testId="n" />);

    expect(container.innerHTML).toBe('');
    expect(scroll).not.toHaveBeenCalled();
  });

  it('scrollIntoView のない環境（jsdom など）でも、落ちずに表示する', () => {
    expect('scrollIntoView' in Element.prototype).toBe(false);

    render(<ResultNotice message="保存しました" testId="saved-notice" />);

    expect(screen.getByRole('status').textContent).toBe('保存しました');
  });
});

describe('表示されたときのスクロール（useRevealOnChange）', () => {
  function Panel(props: { readonly signal: unknown }) {
    const ref = useRevealOnChange<HTMLElement>(props.signal);
    return (
      <section ref={ref} role="status" data-testid="panel">
        パネル
      </section>
    );
  }

  it('合図（signal）が変わるたびに、スクロールする。同じ合図なら、しない', () => {
    const scroll = stubScrollIntoView();
    const first = { id: 1 };
    const { rerender } = render(<Panel signal={first} />);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByTestId('panel'));

    rerender(<Panel signal={first} />);
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(<Panel signal={{ id: 1 }} />);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
});

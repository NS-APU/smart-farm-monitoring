import { StrictMode, useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../../../src/frontend/components/modal.tsx';
import { requireElement } from '../../support/management-frontend.ts';

/** 開くボタンと、ダイアログ（中に、入力欄・ボタン）。 */
function Harness(props: {
  readonly onClose?: () => void;
  readonly withField?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        開く
      </button>
      {open ? (
        <Modal
          title="登録"
          onClose={() => {
            props.onClose?.();
            setOpen(false);
          }}
        >
          {props.withField === false ? null : <input aria-label="名称" />}
          <button type="button">保存</button>
        </Modal>
      ) : null}
    </div>
  );
}

afterEach(() => {
  document.body.className = '';
});

describe('フォームを入れるダイアログ（Modal。Issue #364〜#366）', () => {
  it('role=dialog・aria-modal で、見出し（h2）が名前になる。✕（閉じる）がある', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: '開く' }));

    const dialog = screen.getByRole('dialog', { name: '登録' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { level: 2, name: '登録' })).toBeDefined();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeDefined();
  });

  it('開いたら、本文の最初の入力欄にフォーカスを移す。入力欄がなければ、✕（閉じる）', () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名称' }));
    unmount();

    render(<Harness withField={false} />);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '閉じる' }));
  });

  it('開いている間は、背面（本文）のスクロールを止める（modal-open）。閉じると、外す', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    expect(document.body.classList.contains('modal-open')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });

  it('Esc・✕で閉じる。閉じたら、開いたボタンにフォーカスを戻す', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: '開く' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);

    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(opener);
  });

  it('開発ビルド（StrictMode。効果を 2 回実行する）でも、閉じたら、開いたボタンにフォーカスを戻す（最初の入力欄ではない）', () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const opener = screen.getByRole('button', { name: '開く' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '名称' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('背面（スクリーン）を押しても、閉じない（入力の途中を、失わない）', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), {
      target: { value: '入力中' },
    });

    fireEvent.click(requireElement(document.querySelector('.modal-backdrop')));

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名称' }).value).toBe('入力中');
  });

  it('Tab の移動を、ダイアログの中に閉じ込める（最後の次は最初、最初の前は最後）', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    const close = screen.getByRole('button', { name: '閉じる' });
    const save = screen.getByRole('button', { name: '保存' });

    // 最後（保存）で Tab → 最初（閉じる）
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    // 最初（閉じる）で Shift+Tab → 最後（保存）
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);

    // ダイアログの外にフォーカスがあるときは、中の最初へ移す
    screen.getByRole('button', { name: '開く', hidden: true }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('Tab・Esc 以外のキーは、何もしない（フォーカスは、そのまま。ダイアログは、開いたまま）', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '開く' }));
    const field = screen.getByRole('textbox', { name: '名称' });
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(document, { key: 'a' });

    expect(document.activeElement).toBe(field);
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('wide は、広い幅のクラスを付ける。testId を指定できる', () => {
    render(
      <Modal title="割り当て" size="wide" testId="wide-dialog" onClose={vi.fn()}>
        <p>本文</p>
      </Modal>,
    );

    const dialog = screen.getByTestId('wide-dialog');
    expect(dialog.classList.contains('modal-wide')).toBe(true);
  });
});

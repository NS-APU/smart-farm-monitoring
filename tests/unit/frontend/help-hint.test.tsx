/**
 * 共通の「ヘルプヒント」（「?」。タップ・キーボードで開く説明。Issue #154 の PR2）と、折りたたみ式の凡例（状態・データの状態）の単体テスト。
 */

import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVALUATION_STATUSES,
  STATUS_LABELS,
  STATUS_MEANINGS,
} from '../../../src/shared/constants/status.ts';
import {
  OBSERVATION_QUALITY_LABELS,
  OBSERVATION_QUALITY_MEANINGS,
} from '../../../src/shared/constants/observation-labels.ts';
import { OBSERVATION_QUALITIES } from '../../../src/shared/constants/status.ts';
import { HelpHint } from '../../../src/frontend/components/help-hint.tsx';
import { Legend, QualityLegend, StatusLegend } from '../../../src/frontend/components/legend.tsx';
import { Modal } from '../../../src/frontend/components/modal.tsx';

afterEach(() => {
  document.body.className = '';
});

/** ヘルプヒントのボタン（名前は、「{対象}の説明」）。 */
const hintButton = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('ヘルプヒント（HelpHint）', () => {
  it('はじめは閉じている。ボタンの名前は「{対象}の説明」で、aria-expanded=false。説明は出ていない', () => {
    render(<HelpHint name="走行停止率" help="走行が止まっていた時間の割合です" />);

    const button = hintButton('走行停止率の説明');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText('走行が止まっていた時間の割合です')).toBeNull();
  });

  it('ボタンの名前は、表示する文字（?）ではなく、対象の名前を含む（読み上げで、どの項目の説明か分かる）。title 属性に頼らない', () => {
    render(<HelpHint name="走行停止率" help="説明" />);

    const button = hintButton('走行停止率の説明');
    expect(button.getAttribute('title')).toBeNull();
    expect(button.textContent).toContain('?');
    // 名前は、aria-label ではなく、文字から決まる（getByLabel の検索に、入力欄とは別の要素として混ざらない）
    expect(button.getAttribute('aria-label')).toBeNull();
  });

  it('押すと開き、説明と入力例を示す。aria-expanded=true で、aria-controls が説明を指す。もう一度押すと閉じる', () => {
    render(<HelpHint name="湿度" help="ハウス内の湿度です" example="65" />);
    const button = hintButton('湿度の説明');

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('ハウス内の湿度です');
    expect(note.textContent).toContain('例: 65');
    expect(button.getAttribute('aria-controls')).toBe(note.id);

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
    expect(button.getAttribute('aria-controls')).toBeNull();
  });

  it('用語の一覧（terms）を渡すと、用語と説明の組を並べる。入力例がなければ「例」を出さない', () => {
    render(
      <HelpHint
        name="カテゴリ"
        help="入力する情報の種類です"
        terms={[
          { term: '収穫情報', description: '収穫の数・品質' },
          { term: '安全情報', description: '緊急停止・ヒヤリハット' },
        ]}
      />,
    );

    fireEvent.click(hintButton('カテゴリの説明'));

    const text = screen.getByRole('note').textContent;
    expect(text).toContain('収穫情報');
    expect(text).toContain('収穫の数・品質');
    expect(text).toContain('安全情報');
    expect(text).not.toContain('例:');
  });

  it('キーボード: ボタンは Tab で届き（フォーカスできる）、Esc で閉じて、ボタンにフォーカスを残す。Esc は、外側（ダイアログなど）へ伝えない', () => {
    const outerKeydown = vi.fn();
    document.addEventListener('keydown', outerKeydown);
    render(<HelpHint name="走行停止率" help="説明" />);
    const button = hintButton('走行停止率の説明');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tabIndex).toBe(0);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(button, { key: 'Escape' });

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(outerKeydown).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outerKeydown);
  });

  it('閉じているときの Esc は、外側へ伝える（ダイアログを閉じる動作を、邪魔しない）', () => {
    const outerKeydown = vi.fn();
    document.addEventListener('keydown', outerKeydown);
    render(<HelpHint name="走行停止率" help="説明" />);

    fireEvent.keyDown(hintButton('走行停止率の説明'), { key: 'Escape' });

    expect(outerKeydown).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outerKeydown);
  });

  it('外側を押す（タップする）と閉じる。ヒント自身（ボタン・説明）を押しても、押下では閉じない', () => {
    render(
      <div>
        <HelpHint name="走行停止率" help="説明の文" />
        <p>ほかの場所</p>
      </div>,
    );
    const button = hintButton('走行停止率の説明');
    fireEvent.click(button);

    fireEvent.pointerDown(button);
    fireEvent.pointerDown(screen.getByRole('note'));
    expect(button.getAttribute('aria-expanded')).toBe('true');

    fireEvent.pointerDown(screen.getByText('ほかの場所'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('フォーカスが外へ移る（Tab で次へ進む）と閉じる', () => {
    render(
      <div>
        <HelpHint name="走行停止率" help="説明" />
        <button type="button">次のボタン</button>
      </div>,
    );
    const button = hintButton('走行停止率の説明');
    button.focus();
    fireEvent.click(button);

    fireEvent.blur(button, { relatedTarget: screen.getByRole('button', { name: '次のボタン' }) });

    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('1 つを開いているときに、別のヒントを押すと、先のものは閉じる（同時に 1 つだけ開く）', () => {
    render(
      <div>
        <HelpHint name="走行停止率" help="説明 A" />
        <HelpHint name="稼働率" help="説明 B" />
      </div>,
    );
    fireEvent.click(hintButton('走行停止率の説明'));

    fireEvent.pointerDown(hintButton('稼働率の説明'));
    fireEvent.click(hintButton('稼働率の説明'));

    expect(hintButton('走行停止率の説明').getAttribute('aria-expanded')).toBe('false');
    expect(hintButton('稼働率の説明').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('note')).toHaveLength(1);
  });

  it('開いたとき、説明が画面の幅（余白 8px）からはみ出すなら、はみ出す分だけ、横にずらす（右・左）', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rects = [
      // 右にはみ出す（右端 390、画面の幅 375 → 余白 8px を引いて、23 左へ）
      { left: 200, right: 390, width: 190 },
      // 左にはみ出す（左端 -10 → 余白 8px まで、18 右へ）
      { left: -10, right: 150, width: 160 },
    ];
    for (const [index, rect] of rects.entries()) {
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        return this.getAttribute('role') === 'note'
          ? ({ ...rect, top: 0, bottom: 0, x: rect.left, y: 0, height: 0 } as DOMRect)
          : original.call(this);
      };
      Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
      const { unmount } = render(<HelpHint name="走行停止率" help="説明" />);

      fireEvent.click(hintButton('走行停止率の説明'));

      const note = screen.getByRole('note');
      expect(note.style.left).toBe(index === 0 ? '-23px' : '18px');
      unmount();
    }
    HTMLElement.prototype.getBoundingClientRect = original;
  });

  it('ダイアログの中で、Esc を押すと、ヒントだけを閉じ、ダイアログは開いたまま。もう一度押すと、ダイアログが閉じる', () => {
    function Harness(): ReactNode {
      const [open, setOpen] = useState(true);
      return open ? (
        <Modal
          title="登録"
          onClose={() => {
            setOpen(false);
          }}
        >
          <HelpHint name="湿度" help="ハウス内の湿度です" />
        </Modal>
      ) : (
        <p>閉じました</p>
      );
    }
    render(<Harness />);
    const button = hintButton('湿度の説明');
    button.focus();
    fireEvent.click(button);

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '登録' })).toBeDefined();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.getByText('閉じました')).toBeDefined();
  });
});

describe('凡例（Legend。折りたたみ式）', () => {
  it('はじめは閉じている。ボタンで開閉し、aria-expanded・aria-controls で、中身と結ぶ', () => {
    render(
      <Legend title="状態の見かた" testId="legend-test">
        <p>凡例の中身</p>
      </Legend>,
    );
    const toggle = screen.getByRole('button', { name: '状態の見かた' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('凡例の中身')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = screen.getByTestId('legend-test-body');
    expect(body.textContent).toContain('凡例の中身');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('凡例の中身')).toBeNull();
  });
});

describe('状態の凡例（StatusLegend。ダッシュボード）', () => {
  it('正常・注意・異常・不明の意味を、状態の名前とあわせて示す（evaluation.md 2 章の定義）', () => {
    render(<StatusLegend />);

    fireEvent.click(screen.getByRole('button', { name: '状態の見かた' }));

    const body = screen.getByTestId('status-legend-body');
    for (const status of EVALUATION_STATUSES) {
      expect(body.textContent).toContain(STATUS_LABELS[status]);
      expect(body.textContent).toContain(STATUS_MEANINGS[status]);
    }
    expect(STATUS_MEANINGS.UNKNOWN).toContain('評価に必要なデータが足りず');
    expect(STATUS_MEANINGS.ERROR).toContain('農作業者の対応が必要');
  });
});

describe('データの状態の凡例（QualityLegend。計測データ）', () => {
  it('有効・欠損・遅延・不正の意味と、評価での扱い（使う・使わない）を示す（ADR-0016 の D-10 の定義）', () => {
    render(<QualityLegend />);

    fireEvent.click(screen.getByRole('button', { name: 'データの状態の見かた' }));

    const body = screen.getByTestId('quality-legend-body');
    for (const quality of OBSERVATION_QUALITIES) {
      expect(body.textContent).toContain(OBSERVATION_QUALITY_LABELS[quality]);
      expect(body.textContent).toContain(OBSERVATION_QUALITY_MEANINGS[quality].meaning);
    }
    // 評価での扱い: 有効・遅延は使う。欠損・不正は使わない
    expect(OBSERVATION_QUALITY_MEANINGS.VALID.usedInEvaluation).toBe(true);
    expect(OBSERVATION_QUALITY_MEANINGS.LATE.usedInEvaluation).toBe(true);
    expect(OBSERVATION_QUALITY_MEANINGS.MISSING.usedInEvaluation).toBe(false);
    expect(OBSERVATION_QUALITY_MEANINGS.INVALID.usedInEvaluation).toBe(false);
    const rows = Array.from(body.querySelectorAll('dt')).map((term) => term.textContent);
    expect(rows).toEqual(
      OBSERVATION_QUALITIES.map((quality) => OBSERVATION_QUALITY_LABELS[quality]),
    );
    expect(body.textContent).toContain('評価に使います');
    expect(body.textContent).toContain('評価に使いません');
    expect(body.textContent).toContain('「不明」');
  });
});

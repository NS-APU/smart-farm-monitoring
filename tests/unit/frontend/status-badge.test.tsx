/**
 * ステータスのバッジとアイコンの単体テスト（NFR-7.2。色だけに頼らず、形・文字でも示す）。
 */

import { render } from '@testing-library/react';
import {
  EVALUATION_STATUSES,
  STATUS_LABELS,
  type EvaluationStatus,
} from '@smart-farm/shared/constants/status';
import { describe, expect, it } from 'vitest';
import { Icon, STATUS_ICON } from '../../../src/frontend/components/icon.tsx';
import { StatusBadge } from '../../../src/frontend/components/status-badge.tsx';

describe('ステータスのバッジ', () => {
  it.each(EVALUATION_STATUSES)(
    '%s は、状態の class・形のアイコン・文字の 3 つで示す',
    (status: EvaluationStatus) => {
      const { container } = render(<StatusBadge status={status} />);

      const badge = container.querySelector('.status-badge');
      expect(badge?.classList.contains(`status-${status.toLowerCase()}`)).toBe(true);
      expect(badge?.textContent).toBe(STATUS_LABELS[status]);
      const icon = badge?.querySelector('svg');
      expect(icon?.getAttribute('data-icon')).toBe(STATUS_ICON[status]);
    },
  );

  it('4 つの状態は、それぞれ違う形のアイコンを使う（色が区別できなくても、形で区別できる）', () => {
    const names = EVALUATION_STATUSES.map((status) => STATUS_ICON[status]);

    expect(new Set(names).size).toBe(EVALUATION_STATUSES.length);
  });
});

describe('アイコン', () => {
  it('装飾のため、読み上げの対象から外し、フォーカスを受けない', () => {
    const { container } = render(<Icon name="status-error" />);

    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('focusable')).toBe('false');
  });

  it('大きさは、指定がなければ 18px、指定すればその大きさにする', () => {
    const { container } = render(
      <>
        <Icon name="status-normal" />
        <Icon name="status-normal" size={30} />
      </>,
    );

    const [defaultIcon, largeIcon] = Array.from(container.querySelectorAll('svg'));
    expect(defaultIcon?.getAttribute('width')).toBe('18');
    expect(largeIcon?.getAttribute('width')).toBe('30');
    expect(largeIcon?.getAttribute('height')).toBe('30');
  });

  it('色は、文字の色にそろえる（currentColor）', () => {
    const { container } = render(<Icon name="status-caution" />);

    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
});

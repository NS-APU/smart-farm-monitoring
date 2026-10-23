/**
 * 観点のアイコンの単体テスト（全観点に、違う形のアイコンを持つ。装飾のため、読み上げの対象から外す）。
 */

import { render } from '@testing-library/react';
import { VIEWPOINT_IDS } from '@smart-farm/shared/constants/viewpoints';
import { describe, expect, it } from 'vitest';
import { ViewpointIcon } from '../../../src/frontend/components/icon.tsx';

describe('観点のアイコン', () => {
  it.each(VIEWPOINT_IDS)(
    '%s は、観点の ID で識別できるアイコンを、装飾として表示する',
    (viewpointId) => {
      const { container } = render(<ViewpointIcon viewpointId={viewpointId} />);

      const icon = container.querySelector('.viewpoint-icon svg');
      expect(icon?.getAttribute('data-icon')).toBe(`viewpoint-${viewpointId}`);
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(container.textContent).toBe('');
    },
  );

  it('観点ごとに、違う絵（図形）を使う（観点を、アイコンだけでも見分けられる）', () => {
    const drawings = VIEWPOINT_IDS.map((viewpointId) => {
      const { container } = render(<ViewpointIcon viewpointId={viewpointId} />);
      return container.querySelector('svg')?.innerHTML ?? '';
    });

    expect(drawings.every((drawing) => drawing !== '')).toBe(true);
    expect(new Set(drawings).size).toBe(VIEWPOINT_IDS.length);
  });

  it('大きさは、指定がなければ 24px、指定すればその大きさにする', () => {
    const { container } = render(
      <>
        <ViewpointIcon viewpointId="safety" />
        <ViewpointIcon viewpointId="safety" size={22} />
      </>,
    );

    const [defaultIcon, smallIcon] = Array.from(container.querySelectorAll('svg'));
    expect(defaultIcon?.getAttribute('width')).toBe('24');
    expect(smallIcon?.getAttribute('width')).toBe('22');
  });
});

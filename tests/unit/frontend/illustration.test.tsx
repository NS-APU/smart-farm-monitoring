/**
 * 小さなイラスト（イチゴとハウス）の単体テストと、ログイン画面での使われ方。
 * イラストは、装飾（読み上げの対象から外す）で、使う場面は、ログイン・空の状態・404 だけ（ui-design-guidelines.md 7 章）。
 */

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/frontend/app.tsx';
import { HouseAndStrawberry } from '../../../src/frontend/components/illustration.tsx';
import { EmptyState } from '../../../src/frontend/components/state-views.tsx';
import { createFakeFetch, createMemorySession } from '../../support/frontend.ts';
import { withBaseRoutes } from '../../support/management-frontend.ts';

describe('小さなイラスト', () => {
  it('装飾のため、読み上げの対象から外し、フォーカスを受けない', () => {
    const { container } = render(<HouseAndStrawberry />);

    const svg = container.querySelector('svg.illustration');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(container.textContent).toBe('');
  });

  it('幅は、指定がなければ 120px。指定すれば、その幅で、縦横の比を保つ', () => {
    const { container } = render(
      <>
        <HouseAndStrawberry />
        <HouseAndStrawberry width={240} />
      </>,
    );

    const [defaultSvg, largeSvg] = Array.from(container.querySelectorAll('svg'));
    expect(defaultSvg?.getAttribute('width')).toBe('120');
    expect(defaultSvg?.getAttribute('height')).toBe('96');
    expect(largeSvg?.getAttribute('width')).toBe('240');
    expect(largeSvg?.getAttribute('height')).toBe('192');
  });

  it('色は、文字の色にそろえる（ライト・ダークで、色を切り替えられる）', () => {
    const { container } = render(<HouseAndStrawberry />);

    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('空の状態', () => {
  it('イラスト（装飾）と、本文（文・次の操作への導線）を、同じ枠に置く。文字は、本文だけ', () => {
    render(
      <EmptyState testId="sample-empty">
        <p>データがありません</p>
        <a href="/next">次の操作へ</a>
      </EmptyState>,
    );

    const view = screen.getByTestId('sample-empty');
    expect(view.classList.contains('state-view')).toBe(true);
    expect(view.querySelector('svg.illustration')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.textContent).toBe('データがありません次の操作へ');
    expect(within(view).getByRole('link', { name: '次の操作へ' })).toBeDefined();
  });
});

describe('ログイン画面のブランド', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/login');
  });

  it('イラストと、アプリの名前（見出し h1）を、ブランドのブロックにまとめ、ログインの見出しは、別にある', async () => {
    const { fetchFn } = createFakeFetch(withBaseRoutes({}));
    render(<App session={createMemorySession(null)} fetchFn={fetchFn} />);

    const heading = await screen.findByRole('heading', { level: 1 });
    const brand = heading.closest('.login-brand');
    expect(brand).not.toBeNull();
    expect(heading.textContent).toBe('稼働モニタリング');
    expect(brand?.querySelector('svg.illustration')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'ログイン' })).toBeDefined();
  });
});

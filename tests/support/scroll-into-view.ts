/**
 * `Element.prototype.scrollIntoView` の代わり（jsdom には、この関数がない）。結果の通知が、表示されたときに、画面内へスクロールすることを確かめる
 * テスト（Issue #150）が使う。`this`（スクロールされた要素）と引数は、`mock.contexts`・`mock.calls` に残る。
 * テストの後は、`restoreScrollIntoView()` で、もとに戻す。
 */

import { vi, type Mock } from 'vitest';

type ScrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => void;

const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

export function stubScrollIntoView(): Mock<ScrollIntoView> {
  const mock = vi.fn<ScrollIntoView>();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: mock,
    configurable: true,
    writable: true,
  });
  return mock;
}

export function restoreScrollIntoView(): void {
  if (original === undefined) {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  } else {
    Object.defineProperty(Element.prototype, 'scrollIntoView', original);
  }
}

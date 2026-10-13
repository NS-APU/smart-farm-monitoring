/**
 * 小さなルーター（History API）。ルーティングの骨組み用。
 * ルーターのライブラリ（react-router 等）は、ADR-0005 の技術スタックの範囲外のため追加していない。
 * 画面が増えてライブラリが必要になった場合は、依存パッケージの追加として事前確認を取る。
 */

import {
  useCallback,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

const NAVIGATE_EVENT = 'smart-farm:navigate';

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

/** 現在の位置（パス + クエリ）。 */
function getSnapshot(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) {
    window.history.replaceState(null, '', to);
  } else {
    window.history.pushState(null, '', to);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** 現在の位置（パスとクエリ）。ブラウザの `Location`（`window.location` の型）とは別の型。 */
export interface RouterLocation {
  readonly pathname: string;
  readonly search: URLSearchParams;
}

export function useLocation(): RouterLocation {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const url = new URL(snapshot, 'http://localhost');
  return { pathname: url.pathname, search: url.searchParams };
}

export interface RouteDefinition {
  /** `/viewpoints/:viewpointId` のように、`:名前` でパラメータを表す。 */
  readonly path: string;
  readonly render: (params: Readonly<Record<string, string>>) => ReactNode;
}

/** パターンに一致すれば、パラメータを返す。一致しなければ null。 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of patternSegments.entries()) {
    const actual = pathSegments[index];
    if (actual === undefined) {
      return null;
    }
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(actual);
      } catch {
        // 不正なパーセント符号（ブックマークの破損・手入力の誤り）は、一致なしとして扱う（画面全体を白紙にしない）
        return null;
      }
    } else if (segment !== actual) {
      return null;
    }
  }
  return params;
}

export function Routes(props: {
  readonly routes: readonly RouteDefinition[];
  readonly fallback: ReactNode;
}): ReactNode {
  const { pathname } = useLocation();
  for (const route of props.routes) {
    const params = matchPath(route.path, pathname);
    if (params !== null) {
      return route.render(params);
    }
  }
  return props.fallback;
}

export function Link(
  props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { readonly to: string },
): ReactNode {
  const { to, onClick, children, ...rest } = props;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      // 修飾キーつき・別タブ指定のクリックは、ブラウザの既定の動作に任せる
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(to);
    },
    [onClick, to],
  );
  return (
    <a {...rest} href={to} onClick={handleClick}>
      {children}
    </a>
  );
}

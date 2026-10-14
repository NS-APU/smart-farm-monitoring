/** Web Push の窓口（PushBrowser）を、画面へ渡す。指定がなければ、実際のブラウザの機能を使う。 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createBrowserPush, type BrowserEnvironment, type PushBrowser } from './browser-push.ts';

const PushBrowserContext = createContext<PushBrowser | undefined>(undefined);

export function PushBrowserProvider(props: {
  readonly pushBrowser: PushBrowser | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const value = useMemo(
    () =>
      props.pushBrowser ??
      // `window` は、ブラウザの機能（serviceWorker・Notification・PushManager）の窓口として必要な範囲だけを使う
      createBrowserPush(window as unknown as BrowserEnvironment),
    [props.pushBrowser],
  );
  return <PushBrowserContext.Provider value={value}>{props.children}</PushBrowserContext.Provider>;
}

export function usePushBrowser(): PushBrowser {
  const value = useContext(PushBrowserContext);
  if (value === undefined) {
    throw new Error('PushBrowserProvider の外では usePushBrowser を使えません');
  }
  return value;
}

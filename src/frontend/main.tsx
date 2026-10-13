/** ブラウザでの起動エントリ。ロジックを持たない（テストの対象は app.tsx）。 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { createSessionStorageAccess, resolveSessionStorage } from './api/session-storage.ts';
import './styles/app.css';
import './styles/viewpoints.css';
import './styles/management.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root が見つかりません');
}

createRoot(container).render(
  <StrictMode>
    <App
      session={createSessionStorageAccess(resolveSessionStorage())}
      fetchFn={(input, init) => window.fetch(input, init)}
    />
  </StrictMode>,
);

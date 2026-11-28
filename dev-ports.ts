/**
 * 開発・E2E で使うポート。Vite の開発サーバー（src/frontend/vite.config.ts）と Playwright（playwright.config.ts）が共有する。
 * バックエンドのポートは、バックエンドの既定の PORT（src/backend/runtime/config.ts）と同じ値にする。
 *
 * 環境変数 `E2E_PORT_OFFSET`（0 以上の整数。既定 0）を指定すると、2 つのポートに、同じ値を足す。E2E を複数のインスタンスで
 * 並列に実行する（`pnpm test:e2e:parallel`。Issue #519）とき、インスタンスごとにポートを分けるために使う。
 */

const DEFAULT_BACKEND_PORT = 8787;
const DEFAULT_FRONTEND_PORT = 5173;
const MAX_PORT_OFFSET = 50_000;

function readPortOffset(): number {
  const raw = process.env.E2E_PORT_OFFSET ?? '';
  if (raw === '') {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PORT_OFFSET) {
    throw new Error(`E2E_PORT_OFFSET は、0〜${String(MAX_PORT_OFFSET)} の整数で指定してください`);
  }
  return value;
}

/** ポートに足す値（`E2E_PORT_OFFSET`。未指定は 0）。 */
export const PORT_OFFSET = readPortOffset();
export const DEV_BACKEND_PORT = DEFAULT_BACKEND_PORT + PORT_OFFSET;
export const DEV_FRONTEND_PORT = DEFAULT_FRONTEND_PORT + PORT_OFFSET;

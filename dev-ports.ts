/**
 * 開発・E2E で使うポート。Vite の開発サーバー（src/frontend/vite.config.ts）と Playwright（playwright.config.ts）が共有する。
 * バックエンドのポートは、バックエンドの既定の PORT（src/backend/runtime/config.ts）と同じ値にする。
 */

export const DEV_BACKEND_PORT = 8787;
export const DEV_FRONTEND_PORT = 5173;

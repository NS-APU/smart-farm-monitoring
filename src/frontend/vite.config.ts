import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEV_BACKEND_PORT, DEV_FRONTEND_PORT } from '../../dev-ports.ts';

/** API のバックエンド（ローカルの Node サーバー。`pnpm dev:backend`）の接続先。 */
const BACKEND_ORIGIN = `http://127.0.0.1:${String(DEV_BACKEND_PORT)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: DEV_FRONTEND_PORT,
    strictPort: true,
    // 開発中は、API（/api/v1）を同じ origin から呼べるよう、バックエンドへ中継する
    // （ソースのディレクトリ api/ と衝突しないよう、/api ではなく /api/v1 のみ）
    proxy: { '/api/v1': BACKEND_ORIGIN },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
    // CSS の最小化は esbuild で行う（既定の lightningcss は、MPL-2.0 のため導入しない。.license-check/license-report.md）
    cssMinify: 'esbuild',
  },
});

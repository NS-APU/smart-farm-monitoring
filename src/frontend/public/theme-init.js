/*
 * テーマ（ライト・ダーク）の初期の適用（Issue #352）。index.html の <head> で、描画の前に、同期して読み込み、
 * 保存された設定を、html 要素の data-theme に反映する（ブラウザの設定と違う設定のとき、起動の一瞬だけ色が違うのを防ぐ）。
 * システム・保存なし・不正な値は、何もしない（ブラウザの設定に従う）。
 * このファイルは、TypeScript でなく、ビルドを通さずに配信する（CSP でインラインのスクリプトを使えないため、別ファイル）。
 * 保存先のキー・値は、`src/frontend/lib/theme.ts` と同じ。変えるときは、双方を更新する。
 */
(function () {
  try {
    var theme = localStorage.getItem('smart-farm.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch {
    // 保存領域が使えない環境では、何もしない（ブラウザの設定に従う）
  }
})();

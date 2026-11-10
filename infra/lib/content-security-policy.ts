/**
 * 画面（静的ファイル）の配信に付ける CSP（Content-Security-Policy。Issue #127。ADR-0006・security.md）。
 * CloudFront の応答ヘッダーポリシー（evaluation-stack.ts）と、手元の確認（tests/csp/）が、同じ値を使う。
 *
 * 画面が動く最小の許可にする（画面と API は、同じオリジン〔ADR-0006〕。外部のフォント・画像・通信は、使っていない）:
 * - スクリプト・スタイルシート・画像・フォント・通信（API）・サービスワーカー（/sw.js）・マニフェストは、同じオリジンだけ
 * - インラインのスクリプト・eval は、許さない。インラインのスタイルは、`style` 属性（React の style プロパティ。推移の帯の幅）だけを許す
 * - プラグイン（object）・ほかのオリジンの `<base>`・フォームの送信先は、許さない。画面を iframe などに埋め込むことは、許さない（frame-ancestors）
 *
 * 画面に、外部の資源・インラインのスクリプトを加えるときは、ここも変える（変えないと、画面が動かない）。
 */
export const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

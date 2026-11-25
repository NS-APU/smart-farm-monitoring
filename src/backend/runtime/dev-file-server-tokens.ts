/**
 * ローカルのファイルサーバー（`pnpm dev:file-server`。dev-file-server.ts）の、ダミーのトークン。
 * `pnpm simulate`（simulate-cli.ts）が、ローカルの接続先で、書き込み用のトークンの指定がないときの既定にも使う。
 * 明らかにダミーとわかる固定値で、実際の秘密情報では、ない（開発サイト・本番では、使えない）。
 */

/** 読み取り用のダミーのトークン。 */
export const DEV_FILE_SERVER_READ_TOKEN = 'dummy-dev-read-token';
/** 書き込み用のダミーのトークン。 */
export const DEV_FILE_SERVER_WRITE_TOKEN = 'dummy-dev-write-token';

/**
 * 秘密情報のポート（architecture.md 3.1 の SecretPort。Issue #206。ADR-0016 の D-55）。
 * 接続先の認証情報などは、設定には参照名のみを持ち、値はこのポートで読み書きする（NFR-5.4）。
 * 実装: パラメータストア（SecureString。本番・開発サイト）、メモリ・環境変数（ローカル・テスト）。
 * 読み出した値を、ログ・画面・エラーメッセージ・変更履歴に出さない。
 *
 * 参照名は、`<種類>/<名前>` の形式（例: `file-server/robot`・`federation/orion`・`web-push/vapid-private-key`）。
 * 形式は、`secret-reference.ts` で検証する。
 */

/** 秘密情報の状態。値は、含めない（画面には、設定済みか未設定かと、更新日時だけを示す）。 */
export interface SecretStatus {
  readonly configured: boolean;
  /** 更新日時（ISO 8601）。未設定、または、更新日時を持たない保管先（環境変数）では、省略する。 */
  readonly updatedAt?: string;
}

export interface SecretReadOptions {
  /** true なら、キャッシュを使わず、すぐ取り直す（接続先の認証に失敗したときなど）。 */
  readonly refresh?: boolean;
}

export interface SecretPort {
  /** 参照名に対応する秘密情報の値。未設定は undefined。保管先は、一定時間（5 分）、結果をキャッシュしてよい。 */
  get(reference: string, options?: SecretReadOptions): Promise<string | undefined>;
  /** 値を保存する（上書き）。空の値・4 KB を超える値は、拒否する。 */
  set(reference: string, value: string): Promise<void>;
  /** 設定済みか、更新日時はいつか。値は、読まない・返さない。 */
  status(reference: string): Promise<SecretStatus>;
}

/** 値の上限（バイト）。パラメータストアの標準のパラメータの上限（4 KB）。 */
export const MAX_SECRET_VALUE_BYTES = 4096;

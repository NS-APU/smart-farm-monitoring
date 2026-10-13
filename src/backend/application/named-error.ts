/**
 * 名前つきの独自エラー（`name` に、クラス名を設定する）の基底クラスを作る。
 * ポートのエラー（連携・ファイル・通知・形式）と設定のエラーが共通で使う。原因は `cause` に持つ。
 * `name` を、クラス名から求めず引数で受けるのは、バンドルの圧縮でクラス名が変わっても、ログの名前を保つため。
 */

export interface NamedErrorOptions {
  readonly cause?: unknown;
}

export function namedErrorClass(
  name: string,
): new (message: string, options?: NamedErrorOptions) => Error {
  return class extends Error {
    constructor(message: string, options?: NamedErrorOptions) {
      super(message, options);
      this.name = name;
    }
  };
}

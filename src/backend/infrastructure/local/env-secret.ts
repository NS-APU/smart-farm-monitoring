/**
 * 秘密情報のポートの実装（環境変数）。参照名 `X` の値は、環境変数 `SECRET_X` から読む。
 * 本番はシークレット管理サービスの実装に差し替える（TODO: インフラ確定後。security.md）。
 */

import type { SecretPort } from '../../application/ports/secret-port.ts';

/** 現在は、テストでのみ使う（本番の組み立てでは、秘密情報の参照を使っていない。as-built D-04）。 */
export function createEnvSecretPort(env: Readonly<Record<string, string | undefined>>): SecretPort {
  return {
    get: (reference) => env[`SECRET_${reference}`],
  };
}

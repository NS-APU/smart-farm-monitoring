/**
 * オリジンの秘密（CloudFront が、API のオリジンへの呼び出しに付ける秘密のヘッダーの値）を、Secrets Manager から読む（Issue #102。ADR-0010 の追記）。
 * API の Lambda が、コールドスタートの 1 回だけ、環境変数の ARN（ORIGIN_VERIFY_ARN。秘密の値ではない）で読む。
 * 秘密の値を、Lambda の環境変数（設定）に持たない。
 *
 * - 値は、英数字 32〜128 文字（IaC の自動生成の設定と同じ）。正しくなければ、失敗する（検証が、弱い値で動くことを防ぐ）
 * - 値・ARN・AWS のエラーの内容は、エラー・ログに出さない。AWS のエラーは、種類の名前だけを伝える
 */

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { namedErrorClass } from '../../application/named-error.ts';
import { ORIGIN_SECRET_PATTERN } from '../../presentation/origin-guard.ts';

/** Secrets Manager のクライアントの、必要な部分（SDK の `SecretsManagerClient` が満たす。テストでは、偽物に差し替える）。 */
export interface SecretsManagerSender {
  send(command: { readonly input: unknown }): Promise<unknown>;
}

export class OriginSecretError extends namedErrorClass('OriginSecretError') {}

export interface OriginSecretReaderOptions {
  readonly client: SecretsManagerSender;
}

/** ARN を指定して、オリジンの秘密の値を読む関数。 */
export type OriginSecretReader = (arn: string) => Promise<string>;

export function createOriginSecretReader(options: OriginSecretReaderOptions): OriginSecretReader {
  return async (arn) => {
    let output: unknown;
    try {
      output = await options.client.send(new GetSecretValueCommand({ SecretId: arn }));
    } catch (error) {
      const kind = error instanceof Error ? error.name : '不明なエラー';
      throw new OriginSecretError(
        `オリジンの秘密を、Secrets Manager から読めませんでした（${kind}）。権限・ARN・リージョンの設定を確認してください`,
      );
    }
    const value = (output as { readonly SecretString?: unknown } | undefined)?.SecretString;
    if (typeof value !== 'string' || !ORIGIN_SECRET_PATTERN.test(value)) {
      throw new OriginSecretError(
        'オリジンの秘密の値が正しくありません（英数字 32〜128 文字の文字列が必要です）',
      );
    }
    return value;
  };
}

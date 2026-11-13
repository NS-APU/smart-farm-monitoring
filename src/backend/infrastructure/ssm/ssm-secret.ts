/**
 * パラメータストア（SecureString）の SecretPort（Issue #206。ADR-0016 の D-55）。
 * - 参照名に、環境ごとのパスの接頭辞（例: `/sfm/development/`）をつけて、読み書きする。値は、AWS の管理の鍵で暗号化される
 * - 読み取りの結果は、5 分、プロセス（Lambda の実行環境）の中でキャッシュする。`refresh` を指定すると、すぐ取り直す
 *   （接続先の認証に失敗したとき。ADR-0009 の「コールドスタートで 1 度だけ取得」を改めた）
 * - 書き込みは、そのプロセスのキャッシュを、新しい値にする（ほかのプロセスは、最長 5 分で、新しい値になる）
 * - 状態の確認は、値を復号せず、キャッシュもしない（画面が、保存の直後の状態を示すため）
 * - 値を、ログ・エラーに出さない。AWS のエラーの内容は、エラーの種類の名前のほかは、出さない
 */

import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { AppError } from '@smart-farm/shared/errors';
import type { Logger } from '../../application/ports/logger-port.ts';
import type { SecretPort, SecretStatus } from '../../application/ports/secret-port.ts';
import {
  assertValidSecretValue,
  parseSecretReference,
} from '../../application/secret-reference.ts';

/** 読み取りの結果を、プロセスの中でキャッシュする期間（ミリ秒。5 分）。 */
export const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

/** パラメータストアのクライアントの、必要な部分（SDK の `SSMClient` が満たす。テストでは、偽物に差し替える）。 */
export interface SsmCommandSender {
  send(command: { readonly input: unknown }): Promise<unknown>;
}

export interface SsmSecretPortOptions {
  readonly client: SsmCommandSender;
  /** パスの接頭辞（環境ごと。先頭と末尾が `/`。例: `/sfm/development/`）。 */
  readonly pathPrefix: string;
  readonly now?: () => number;
  /** 失敗の記録用。エラーの種類の名前だけを、記録する（値・AWS のエラーの内容は、記録しない）。 */
  readonly logger?: Logger;
}

interface CacheEntry {
  readonly value: string | undefined;
  readonly expiresAt: number;
}

interface ParameterOutput {
  readonly Parameter?: {
    readonly Value?: string;
    readonly LastModifiedDate?: Date;
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ParameterNotFound';
}

export function createSsmSecretPort(options: SsmSecretPortOptions): SecretPort {
  const { client, pathPrefix, logger } = options;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  const nameOf = (reference: string): string => `${pathPrefix}${parseSecretReference(reference)}`;

  function failure(operation: string, message: string, error: unknown): AppError {
    logger?.warn(operation, { errorName: error instanceof Error ? error.name : 'unknown' });
    return new AppError('SERVICE_UNAVAILABLE', message);
  }

  return {
    async get(reference, readOptions) {
      const name = nameOf(reference);
      const cached = cache.get(name);
      if (readOptions?.refresh !== true && cached !== undefined && now() < cached.expiresAt) {
        return cached.value;
      }
      let value: string | undefined;
      try {
        const output = (await client.send(
          new GetParameterCommand({ Name: name, WithDecryption: true }),
        )) as ParameterOutput;
        value = output.Parameter?.Value;
      } catch (error) {
        if (!isNotFound(error)) {
          throw failure(
            '秘密情報の読み取りに失敗しました',
            '秘密情報を読み取れませんでした',
            error,
          );
        }
      }
      cache.set(name, { value, expiresAt: now() + SECRET_CACHE_TTL_MS });
      return value;
    },

    async set(reference, value) {
      const name = nameOf(reference);
      assertValidSecretValue(value);
      try {
        await client.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Type: 'SecureString',
            Overwrite: true,
            Tier: 'Standard',
          }),
        );
      } catch (error) {
        throw failure('秘密情報の保存に失敗しました', '秘密情報を保存できませんでした', error);
      }
      cache.set(name, { value, expiresAt: now() + SECRET_CACHE_TTL_MS });
    },

    async status(reference): Promise<SecretStatus> {
      const name = nameOf(reference);
      try {
        const output = (await client.send(
          new GetParameterCommand({ Name: name, WithDecryption: false }),
        )) as ParameterOutput;
        const modified = output.Parameter?.LastModifiedDate;
        return modified === undefined
          ? { configured: true }
          : { configured: true, updatedAt: modified.toISOString() };
      } catch (error) {
        if (isNotFound(error)) {
          return { configured: false };
        }
        throw failure(
          '秘密情報の状態の確認に失敗しました',
          '秘密情報の状態を確認できませんでした',
          error,
        );
      }
    },
  };
}

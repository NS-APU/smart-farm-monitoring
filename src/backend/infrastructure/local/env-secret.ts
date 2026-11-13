/**
 * 秘密情報のポートの、ローカル・テスト用の実装（メモリ・環境変数。Issue #206）。
 * 本番・開発サイトは、パラメータストアの実装（`infrastructure/ssm/ssm-secret.ts`）を使う。
 * 参照名・値の検証は、パラメータストアの実装と同じ。
 */

import type { SecretPort, SecretStatus } from '../../application/ports/secret-port.ts';
import {
  assertValidSecretValue,
  parseSecretReference,
} from '../../application/secret-reference.ts';

interface StoredSecret {
  readonly value: string;
  readonly updatedAt: string;
}

/** メモリに持つ SecretPort。`clear` は、保存した値を、すべて消す（開発用のリセット。ローカル・テストだけ）。 */
export interface MemorySecretPort extends SecretPort {
  clear(): void;
}

/** メモリに持つ SecretPort。初期値の更新日時は、作成時の時刻。 */
export function createMemorySecretPort(
  initial: Readonly<Record<string, string>> = {},
  now: () => number = Date.now,
): MemorySecretPort {
  const store = new Map<string, StoredSecret>();
  for (const [reference, value] of Object.entries(initial)) {
    store.set(parseSecretReference(reference), {
      value,
      updatedAt: new Date(now()).toISOString(),
    });
  }
  return {
    clear() {
      store.clear();
    },
    // 不正な参照名・値は、同期の例外ではなく、拒否された Promise にする（パラメータストアの実装と同じ）
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(reference) {
      return store.get(parseSecretReference(reference))?.value;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async set(reference, value) {
      const parsed = parseSecretReference(reference);
      assertValidSecretValue(value);
      store.set(parsed, { value, updatedAt: new Date(now()).toISOString() });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async status(reference) {
      const entry = store.get(parseSecretReference(reference));
      return entry === undefined
        ? { configured: false }
        : { configured: true, updatedAt: entry.updatedAt };
    },
  };
}

/** 参照名 `file-server/robot` の値を読む環境変数の名前: `SECRET_FILE_SERVER_ROBOT`（英大文字・数字・`_` に置き換える）。 */
function envNameOf(reference: string): string {
  return `SECRET_${reference.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * 環境変数から読む SecretPort。書き込みは、メモリにだけ持つ（環境変数・プロセスの外は、変えない）。
 * 書き込みが、環境変数の値より優先する。
 */
export function createEnvSecretPort(
  env: Readonly<Record<string, string | undefined>>,
  now: () => number = Date.now,
): SecretPort {
  const written = createMemorySecretPort({}, now);
  return {
    async get(reference, options) {
      const parsed = parseSecretReference(reference);
      return (await written.get(parsed, options)) ?? env[envNameOf(parsed)];
    },
    set: (reference, value) => written.set(reference, value),
    async status(reference): Promise<SecretStatus> {
      const parsed = parseSecretReference(reference);
      const fromWrite = await written.status(parsed);
      if (fromWrite.configured) {
        return fromWrite;
      }
      return env[envNameOf(parsed)] === undefined ? { configured: false } : { configured: true };
    },
  };
}

/**
 * ローカル実行用のデータ保持（インメモリ＋JSON ファイルへの永続化）。
 * AWS なしで、E2E・負荷テストを動かすための実装。本番の DynamoDB の実装は、同じ Repository の
 * ポートの実装として後で追加する（DynamoDB ローカル等の追加パッケージは使わない）。
 * ファイルの内容は、読み込み時にスキーマで検証する（壊れたデータを内部に渡さない）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface Collection<Value> {
  get(key: string): Value | undefined;
  put(value: Value): void;
  delete(key: string): boolean;
  values(): Value[];
  readonly size: number;
}

export interface LocalStoreOptions {
  /** 永続化先のファイル。未指定ならインメモリのみ（テスト用）。 */
  readonly filePath?: string | undefined;
  /** 変更から保存までの待ち時間（ミリ秒）。連続した変更をまとめて書く。 */
  readonly flushDelayMs?: number | undefined;
  /**
   * 変更を待ち時間のあとに書く処理（タイマー）が失敗したときに呼ぶ（ディスクの容量不足・権限など）。
   * 失敗しても、メモリ上の変更は保持し、待ち時間を広げて再び書く（プロセスを落とさない。V-194）。
   */
  readonly onFlushError?: ((error: unknown) => void) | undefined;
}

export interface LocalStore {
  collection<Value>(
    name: string,
    schema: z.ZodType<Value>,
    keyOf: (value: Value) => string,
  ): Collection<Value>;
  /** ファイルから読み込む（すべてのコレクションを登録した後に1度呼ぶ）。ファイルがなければ何もしない。 */
  load(): void;
  /** 未保存の変更を、すぐにファイルへ書く。 */
  flush(): void;
  /** すべてのデータを消す（開発用のリセット）。 */
  clear(): void;
}

interface Registered {
  readonly entries: Map<string, unknown>;
  /** 読み込み時に、値を検証して、保存済みのキーで登録する。 */
  readonly restore: (rawValue: unknown) => void;
}

/** ファイルの形式。コレクションごとの値は、各コレクションのスキーマで、1件ずつ検証する。 */
const StoreFileSchema = z.object({
  version: z.number().int().optional(),
  collections: z.record(z.string(), z.array(z.unknown())).optional(),
});

export const FILE_FORMAT_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 300;
/** 書き込みの失敗が続くときの、再試行の待ち時間の上限（ミリ秒）。 */
const MAX_RETRY_DELAY_MS = 30_000;
/** データファイルの権限（所有者のみ）。パスワードのハッシュを含む全データを、ほかのユーザーに読ませない（V-142）。 */
const DATA_FILE_MODE = 0o600;
const DATA_DIRECTORY_MODE = 0o700;

/** データファイルを読み込めない（破損・版が新しい）。原因を、ファイル名つきで示す。 */
export class LocalStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'LocalStoreError';
  }
}

export function createLocalStore(options: LocalStoreOptions = {}): LocalStore {
  const registered = new Map<string, Registered>();
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const filePath = options.filePath;
    if (!dirty || filePath === undefined) {
      dirty = false;
      return;
    }
    const collections: Record<string, unknown[]> = {};
    for (const [name, { entries }] of registered) {
      collections[name] = [...entries.values()];
    }
    mkdirSync(dirname(filePath), { recursive: true, mode: DATA_DIRECTORY_MODE });
    // 書き込み途中で壊れないよう、一時ファイルに書いてから置き換える
    const temporaryPath = `${filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ version: FILE_FORMAT_VERSION, collections }), {
      encoding: 'utf8',
      mode: DATA_FILE_MODE,
    });
    renameSync(temporaryPath, filePath);
    dirty = false;
    consecutiveFailures = 0;
  }

  /** タイマーからの書き込み。失敗しても例外を投げず（プロセスを落とさず）、通知して、待ち時間を広げて再び書く。 */
  function flushFromTimer(): void {
    timer = undefined;
    try {
      flush();
    } catch (error) {
      consecutiveFailures += 1;
      options.onFlushError?.(error);
      // メモリ上の変更（dirty）は保持する。次の書き込みを、待ち時間を広げて予約する
      schedule(Math.min(flushDelayMs * 2 ** consecutiveFailures, MAX_RETRY_DELAY_MS));
    }
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(flushFromTimer, delayMs);
    timer.unref();
  }

  function markDirty(): void {
    dirty = true;
    if (options.filePath === undefined || timer !== undefined) {
      return;
    }
    schedule(flushDelayMs);
  }

  return {
    collection<Value>(name: string, schema: z.ZodType<Value>, keyOf: (value: Value) => string) {
      if (registered.has(name)) {
        throw new Error(`コレクションが重複しています: ${name}`);
      }
      const entries = new Map<string, Value>();
      registered.set(name, {
        entries,
        restore(rawValue) {
          const value = schema.parse(rawValue);
          entries.set(keyOf(value), value);
        },
      });
      const collection: Collection<Value> = {
        get: (key) => entries.get(key),
        put(value) {
          entries.set(keyOf(value), value);
          markDirty();
        },
        delete(key) {
          const existed = entries.delete(key);
          if (existed) {
            markDirty();
          }
          return existed;
        },
        values: () => [...entries.values()],
        get size() {
          return entries.size;
        },
      };
      return collection;
    },

    load() {
      if (options.filePath === undefined || !existsSync(options.filePath)) {
        return;
      }
      const filePath = options.filePath;
      try {
        const parsed = StoreFileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
        if (parsed.version !== undefined && parsed.version > FILE_FORMAT_VERSION) {
          throw new LocalStoreError(
            `データファイルの版（${String(parsed.version)}）が、このアプリが扱える版（${String(FILE_FORMAT_VERSION)}）より新しいため、読み込めません`,
          );
        }
        for (const [name, { entries, restore }] of registered) {
          entries.clear();
          for (const rawValue of parsed.collections?.[name] ?? []) {
            restore(rawValue);
          }
        }
      } catch (error) {
        // 元のファイルは、そのまま残す（自動では、消さない・置き換えない）。調査・復旧のため、控えを残し、原因を明確に示す
        const backupPath = `${filePath}.corrupt-${new Date().toISOString().replaceAll(':', '-')}`;
        copyFileSync(filePath, backupPath);
        if (error instanceof LocalStoreError) {
          throw error;
        }
        throw new LocalStoreError(
          `データファイルを読み込めません（${filePath}）。ファイルの内容が、現在の形式と合いません。控えを ${backupPath} に残しました。復旧の手順は docs/40_operations/ を参照してください`,
          { cause: error },
        );
      }
    },

    flush,

    clear() {
      for (const { entries } of registered.values()) {
        entries.clear();
      }
      markDirty();
    },
  };
}

/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の、ファイル保管のポート（HostedFileStorePort）の、テスト用のメモリ実装。
 * 呼ばれた書き込みの回数と、障害の再現（読み書きの失敗）を持つ。実際の S3 には、接続しない。
 */

import type {
  HostedFile,
  HostedFileMetadata,
  HostedFileStorePort,
} from '../../src/backend/application/ports/hosted-file-store-port.ts';

export interface MemoryHostedFileStore extends HostedFileStorePort {
  /** 書き込みの成功の回数。 */
  readonly putCount: () => number;
  /** 保管している、すべてのパス。 */
  readonly paths: () => string[];
  /** 次の呼び出しから、指定のエラーで失敗させる（`undefined` で解除）。 */
  readonly failWith: (error: Error | undefined) => void;
}

export function createMemoryHostedFileStore(
  now: () => Date = () => new Date(),
): MemoryHostedFileStore {
  const files = new Map<string, { body: string; lastModified: Date; etag: string }>();
  let puts = 0;
  let failure: Error | undefined;
  const guard = (): void => {
    if (failure !== undefined) {
      throw failure;
    }
  };
  const metadataOf = (entry: {
    body: string;
    lastModified: Date;
    etag: string;
  }): HostedFileMetadata => ({
    lastModified: entry.lastModified,
    etag: entry.etag,
    size: Buffer.byteLength(entry.body, 'utf8'),
  });
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async head(path) {
      guard();
      const entry = files.get(path);
      return entry === undefined ? undefined : metadataOf(entry);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(path): Promise<HostedFile | undefined> {
      guard();
      const entry = files.get(path);
      return entry === undefined ? undefined : { ...metadataOf(entry), body: entry.body };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async put(path, body) {
      guard();
      puts += 1;
      files.set(path, { body, lastModified: now(), etag: `"etag-${String(puts)}"` });
    },
    putCount: () => puts,
    paths: () => [...files.keys()],
    failWith: (error) => {
      failure = error;
    },
  };
}

/**
 * ファイルを置く保管先（HostedFileStorePort。Issue #565。ADR-0027）の、ローカル・テスト用のメモリ実装。
 * 本番・開発サイトは、S3 の実装（`infrastructure/s3/s3-hosted-file-store.ts`）を使う。
 * 書き込みの日時は、時計から取る（取り込みの「書き換えの直後は、次の周期に回す」の判定が、時計を操作するテストと合うように）。
 */

import type {
  HostedFileMetadata,
  HostedFileStorePort,
} from '../../application/ports/hosted-file-store-port.ts';
import type { ClockPort } from '../../application/ports/clock-port.ts';

interface StoredFile {
  readonly body: string;
  readonly lastModified: Date;
  readonly etag: string;
}

export function createMemoryHostedFileStore(clock: ClockPort): HostedFileStorePort {
  const files = new Map<string, StoredFile>();
  let version = 0;
  const metadataOf = (file: StoredFile): HostedFileMetadata => ({
    lastModified: file.lastModified,
    etag: file.etag,
    size: Buffer.byteLength(file.body, 'utf8'),
  });
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async head(path) {
      const file = files.get(path);
      return file === undefined ? undefined : metadataOf(file);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(path) {
      const file = files.get(path);
      return file === undefined ? undefined : { ...metadataOf(file), body: file.body };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async put(path, body) {
      version += 1;
      files.set(path, { body, lastModified: clock.now(), etag: `"memory-${String(version)}"` });
    },
  };
}

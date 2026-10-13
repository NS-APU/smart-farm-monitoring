/**
 * ファイルサーバーのモック（FileSourcePort のローカル実装）。
 * ローカルのディレクトリを、ファイルサーバーに見立てる。構成: `<ルート>/<取り込み元の識別子>/<ファイル>`。
 * 検証用のデータは合成データのみ（tests/fixtures/ 参照）。停止・遅延を再現できる（FaultController）。
 * 実ファイルサーバーのアダプタ（SFTP・S3 等。Q-002）は、同じ契約テストを適用して追加する。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ClockPort } from '../../application/ports/clock-port.ts';
import {
  FileSourceUnavailableError,
  type FileMeta,
  type FileSourcePort,
} from '../../application/ports/file-source-port.ts';
import type { FaultController } from './faults.ts';

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface DirectoryFileSourceOptions {
  readonly rootDirectory: string;
  readonly faults: FaultController;
  readonly clock: ClockPort;
}

export function createDirectoryFileSource(options: DirectoryFileSourceOptions): FileSourcePort {
  const { rootDirectory, faults, clock } = options;

  async function simulateFaults(): Promise<void> {
    const fault = faults.get();
    if (fault.mode === 'DOWN') {
      throw new FileSourceUnavailableError('ファイルサーバーに接続できません');
    }
    if (fault.mode === 'SLOW') {
      await clock.sleep(fault.delayMs);
    }
  }

  function directoryOf(sourceId: string): string {
    // 取り込み元の識別子でディレクトリの外へ出られないようにする
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      throw new FileSourceUnavailableError('取り込み元の識別子が不正です');
    }
    return join(rootDirectory, sourceId);
  }

  return {
    async testConnection(sourceId) {
      await simulateFaults();
      if (!existsSync(directoryOf(sourceId))) {
        throw new FileSourceUnavailableError('取り込み元のディレクトリが見つかりません');
      }
    },

    async listFiles(sourceId) {
      await simulateFaults();
      const directory = directoryOf(sourceId);
      if (!existsSync(directory)) {
        return [];
      }
      const files: FileMeta[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile()) {
          const stats = statSync(join(directory, entry.name));
          files.push({
            fileId: entry.name,
            name: entry.name,
            modifiedAt: stats.mtime,
            sizeBytes: stats.size,
          });
        }
      }
      return files.sort(
        (left, right) =>
          left.modifiedAt.getTime() - right.modifiedAt.getTime() ||
          left.name.localeCompare(right.name),
      );
    },

    async readFile(sourceId, fileId) {
      await simulateFaults();
      if (basename(fileId) !== fileId) {
        throw new FileSourceUnavailableError('ファイルの識別子が不正です');
      }
      const path = join(directoryOf(sourceId), fileId);
      if (!existsSync(path)) {
        throw new FileSourceUnavailableError('ファイルが見つかりません');
      }
      return readFileSync(path, 'utf8');
    },
  };
}

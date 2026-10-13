/**
 * ファイル取得のポート（FileSourcePort。ADR-0003、architecture.md 5.1）。
 * 「どこから取るか」だけを担い、読み取り専用。ファイルの解釈は FormatProfile が担う。
 * 実装の候補: ローカルディレクトリ（開発・検証のモック）、SFTP、S3、HTTPS など（Q-002）。
 * 実ファイルサーバーのアダプタには、モックと同じ契約テストを適用する。
 */

import { namedErrorClass } from '../named-error.ts';

export interface FileMeta {
  /** ファイルの識別子（取り込み元の中で一意。例: 相対パス）。 */
  readonly fileId: string;
  readonly name: string;
  readonly modifiedAt: Date;
  readonly sizeBytes: number;
}

/** 接続先が利用できない（停止・接続不可・認証失敗など）。再試行の対象。 */
export class FileSourceUnavailableError extends namedErrorClass('FileSourceUnavailableError') {}

export interface FileSourcePort {
  /** 接続テスト。失敗した場合は FileSourceUnavailableError を投げる。 */
  testConnection(sourceId: string): Promise<void>;
  /** 取り込み元のファイルの一覧（更新日時の古い順）。 */
  listFiles(sourceId: string): Promise<FileMeta[]>;
  /** ファイルの内容（UTF-8 のテキスト）。 */
  readFile(sourceId: string, fileId: string): Promise<string>;
}

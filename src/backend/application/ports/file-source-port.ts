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

/** 接続先が利用できない理由（Issue #172）。利用者に見せるため、接続先・ファイルパス・認証情報を含めない文言にする。 */
export const FILE_SOURCE_FAILURE_REASONS = {
  CREDENTIALS_MISSING: '認証情報が設定されていません',
  CREDENTIALS_INVALID: '認証情報の形式が正しくありません',
  CREDENTIALS_UNAVAILABLE: '認証情報を読み出せません',
  AUTH_FAILED: 'ファイルサーバーの認証に失敗しました',
  NOT_FOUND: 'ファイルが見つかりません',
  SERVER_ERROR: 'ファイルサーバーがエラーを返しました',
  UNEXPECTED_RESPONSE: 'ファイルサーバーが想定外の応答を返しました',
  REDIRECT: 'ファイルサーバーが別の場所への移動を指示しました（リダイレクトには従いません）',
  UNREACHABLE: 'ファイルサーバーに接続できません',
  TIMEOUT: 'ファイルサーバーが応答しません',
  CERTIFICATE: 'ファイルサーバーの証明書を確認できません',
  TLS: 'ファイルサーバーとの暗号化通信に失敗しました',
  ADDRESS_BLOCKED: '内部のアドレスには接続できません',
  TOO_LARGE: 'ファイルが大きすぎます',
  NO_FILE_PATH: 'ファイルパスが設定された設備がありません',
  NOT_CONFIGURED: '接続先が設定されていません',
} as const;
export type FileSourceFailureReason = keyof typeof FILE_SOURCE_FAILURE_REASONS;

/** 理由が分かる接続の失敗。メッセージは、理由ごとに固定（原因の詳細は、`cause` に残す。ログにも、値は出さない）。 */
export class FileSourceFailure extends FileSourceUnavailableError {
  readonly reason: FileSourceFailureReason;

  constructor(reason: FileSourceFailureReason, options?: { readonly cause?: unknown }) {
    super(FILE_SOURCE_FAILURE_REASONS[reason], options);
    this.reason = reason;
  }
}

/** ファイルの一覧の取得の指定（Issue #197）。 */
export interface ListFilesOptions {
  /**
   * 取得するファイルのパス（設備ごとのファイル）。指定すると、そのパスのファイルだけを問い合わせる
   * （設備ごとの取得間隔で、間隔が来た設備のファイルだけを取り込むため）。空は、何も問い合わせない。
   * 未指定は、すべて。
   */
  readonly paths?: readonly string[] | undefined;
  /**
   * 設備ごとの失敗の受け取り（Issue #367。ADR-0026）。指定すると、ファイルごとの失敗（接続・認証・未設定など。ファイルが見つからない
   * 場合を除く）を、投げずに、ここへ渡し、そのファイルを除いて一覧を返す（1 つの設備の接続の失敗が、他の設備の取り込みを止めない）。
   * 指定がなければ、最初の失敗を投げる（これまでの動作）。
   */
  readonly onFailure?: ((failure: FileListFailure) => void) | undefined;
}

/** 一覧の取得で、ファイルごとに失敗したもの。 */
export interface FileListFailure {
  /** 失敗したファイルのパス（設備の `sourceFilePath`）。 */
  readonly path: string;
  readonly error: FileSourceUnavailableError;
}

export interface FileSourcePort {
  /** 設備 1 つの接続テスト（その設備の接続・認証情報・ファイルのパス。Issue #367）。失敗した場合は FileSourceUnavailableError を投げる。 */
  testEquipment(equipmentId: string): Promise<void>;
  /** 取り込み元のファイルの一覧（更新日時の古い順）。 */
  listFiles(sourceId: string, options?: ListFilesOptions): Promise<FileMeta[]>;
  /** ファイルの内容（UTF-8 のテキスト）。 */
  readFile(sourceId: string, fileId: string): Promise<string>;
}

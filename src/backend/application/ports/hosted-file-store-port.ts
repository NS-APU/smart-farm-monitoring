/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）が、ファイルを保管するポート。
 * ファイルは、設備ごとのファイルパス（`/` で始まる。`FilePathSchema` で検証済み）で決める。1 パス = 1 ファイルで、書き込みのたびに全体を置き換える
 * （1 つのファイルを随時更新する方式。ADR-0016 の D-08）。置き換えは、原子的（書き換えの途中のファイルを、読み手に見せない）。
 * 実装: S3（`infrastructure/s3/s3-hosted-file-store.ts`）。テストは、メモリの実装を使う（`tests/support/memory-hosted-file-store.ts`）。
 */

export interface HostedFileMetadata {
  /** 最後に書き込まれた日時（HTTP の `Last-Modified` になる）。 */
  readonly lastModified: Date;
  /** 内容の識別子（HTTP の `ETag` になる。引用符を含む形式）。保管先が返さなければ省略する。 */
  readonly etag?: string;
  /** 大きさ（バイト）。 */
  readonly size: number;
}

export interface HostedFile extends HostedFileMetadata {
  /** 内容（UTF-8 のテキスト）。 */
  readonly body: string;
}

export interface HostedFileStorePort {
  /** メタデータだけを得る。ファイルがなければ undefined。 */
  head(path: string): Promise<HostedFileMetadata | undefined>;
  /** 内容とメタデータを得る。ファイルがなければ undefined。 */
  get(path: string): Promise<HostedFile | undefined>;
  /** ファイルを、置き換える（なければ作る）。 */
  put(path: string, body: string): Promise<void>;
}

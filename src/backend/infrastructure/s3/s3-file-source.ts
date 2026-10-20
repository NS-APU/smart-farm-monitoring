/**
 * ファイルサーバーのモックの S3 版（FileSourcePort。Issue #77。ADR-0012）。Lambda には、ローカルのディレクトリがないため、
 * S3 のバケットを、ファイルサーバーに見立てる。構成は、ローカルのモックと同じ: `s3://<バケット>/<取り込み元の識別子>/<ファイル>`。
 * 置くのは、合成データだけ（実データ・個人情報は、置かない。security.md）。実ファイルサーバーのアダプタ（Q-002）では、ない。
 *
 * ローカルのモックとの違い: 停止・遅延の再現（FaultController）は、ない（開発用 API は、本番で無効）。接続テストは、
 * バケットの一覧を取れるかを確かめる（S3 には、「ディレクトリ」がなく、ファイルがない取り込み元と、設定の誤りを区別できない）。
 * AWS のエラーは、すべて FileSourceUnavailableError にする（利用者に見せる文言に、内部情報を含めない。原因は `cause` に残す）。
 */

import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import {
  FileSourceUnavailableError,
  type FileMeta,
  type FileSourcePort,
} from '../../application/ports/file-source-port.ts';

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface S3FileSourceOptions {
  /** S3 のクライアント（テストは、偽のクライアントに差し替える）。 */
  readonly client: Pick<S3Client, 'send'>;
  readonly bucket: string;
}

/** ファイルがない（NoSuchKey）。バケットがない（NoSuchBucket。設定の誤り）・権限がない場合は、含めない。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchKey'
  );
}

export function createS3FileSource(options: S3FileSourceOptions): FileSourcePort {
  const { client, bucket } = options;

  function prefixOf(sourceId: string): string {
    // 取り込み元の識別子で、別の取り込み元の場所へ出られないようにする
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      throw new FileSourceUnavailableError('取り込み元の識別子が不正です');
    }
    return `${sourceId}/`;
  }

  /** 取り込み元の直下のオブジェクトを、すべて取る（1,000 件を超えるときは、続きを取る）。 */
  async function listObjects(prefix: string, maxKeys?: number) {
    const objects = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          ...(maxKeys === undefined ? {} : { MaxKeys: maxKeys }),
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      objects.push(...(page.Contents ?? []));
      token =
        maxKeys === undefined && page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return objects;
  }

  return {
    async testConnection(sourceId) {
      const prefix = prefixOf(sourceId);
      try {
        await listObjects(prefix, 1);
      } catch (cause) {
        throw new FileSourceUnavailableError('ファイルサーバーに接続できません', { cause });
      }
    },

    async listFiles(sourceId) {
      const prefix = prefixOf(sourceId);
      let objects;
      try {
        objects = await listObjects(prefix);
      } catch (cause) {
        throw new FileSourceUnavailableError('ファイルサーバーに接続できません', { cause });
      }
      const files: FileMeta[] = [];
      for (const object of objects) {
        const name = object.Key?.slice(prefix.length) ?? '';
        // 「ディレクトリ」を表すオブジェクト（末尾が / のもの）は、ファイルではない
        if (name !== '' && !name.endsWith('/')) {
          files.push({
            fileId: name,
            name,
            modifiedAt: object.LastModified ?? new Date(0),
            sizeBytes: object.Size ?? 0,
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
      const prefix = prefixOf(sourceId);
      // ファイルの識別子で、取り込み元の外へ出られないようにする
      if (fileId === '' || fileId.includes('/') || fileId === '.' || fileId === '..') {
        throw new FileSourceUnavailableError('ファイルの識別子が不正です');
      }
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${fileId}` }),
        );
        if (response.Body === undefined) {
          throw new FileSourceUnavailableError('ファイルを読めませんでした');
        }
        return await response.Body.transformToString('utf-8');
      } catch (cause) {
        if (cause instanceof FileSourceUnavailableError) {
          throw cause;
        }
        throw new FileSourceUnavailableError(
          isNotFound(cause) ? 'ファイルが見つかりません' : 'ファイルサーバーに接続できません',
          { cause },
        );
      }
    },
  };
}

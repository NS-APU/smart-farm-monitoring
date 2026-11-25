/**
 * 自前のファイルサーバー（Issue #298。ADR-0027）の、S3 の保管先（HostedFileStorePort の実装）。
 * 設備ごとのファイルパス（`/robot/<設備>/latest.json` など）を、バケットの `files/` の下の、同じパスのオブジェクトとして置く。
 * `PutObject` は、同じキーの置き換えが原子的で、書き換えの途中のファイルを、読み手に見せない（データ定義 6 章の、望ましい書き換え方式）。
 * ファイルがないときは、`HeadObject` は `NotFound`、`GetObject` は `NoSuchKey` を返す（実行ロールに、バケットの `s3:ListBucket` がないと、
 * どちらも 403 になる。IaC で付ける）。ファイルがないとき以外の失敗は、そのまま投げる（呼び出し側が、503 にする）。
 * パスは、`FilePathSchema` で検証する（`files/` の外を、指せない）。
 */

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { AppError } from '@smart-farm/shared/errors';
import { FilePathSchema } from '@smart-farm/shared/schemas/file-path';
import type {
  HostedFile,
  HostedFileMetadata,
  HostedFileStorePort,
} from '../../application/ports/hosted-file-store-port.ts';

/** バケットの中の、ファイルを置く階層の接頭辞。 */
const KEY_PREFIX = 'files';

/** S3 のクライアントの、必要な部分（SDK の `S3Client` が満たす。テストでは、偽物に差し替える）。 */
export interface S3CommandSender {
  send(command: { readonly input: unknown }): Promise<unknown>;
}

export interface S3HostedFileStoreOptions {
  readonly client: S3CommandSender;
  readonly bucket: string;
}

interface ObjectOutput {
  readonly LastModified?: Date;
  readonly ETag?: string;
  readonly ContentLength?: number;
  readonly Body?: { transformToString(encoding?: string): Promise<string> };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound');
}

export function createS3HostedFileStore(options: S3HostedFileStoreOptions): HostedFileStorePort {
  const { client, bucket } = options;

  function keyOf(path: string): string {
    const parsed = FilePathSchema.safeParse(path);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'ファイルパスが正しくありません');
    }
    return `${KEY_PREFIX}${parsed.data}`;
  }

  function metadataOf(output: ObjectOutput, fallbackSize: number): HostedFileMetadata {
    return {
      lastModified: output.LastModified ?? new Date(0),
      ...(output.ETag === undefined ? {} : { etag: output.ETag }),
      size: output.ContentLength ?? fallbackSize,
    };
  }

  return {
    async head(path) {
      const key = keyOf(path);
      try {
        const output = (await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        )) as ObjectOutput;
        return metadataOf(output, 0);
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async get(path): Promise<HostedFile | undefined> {
      const key = keyOf(path);
      try {
        const output = (await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as ObjectOutput;
        const body = (await output.Body?.transformToString('utf-8')) ?? '';
        return { ...metadataOf(output, Buffer.byteLength(body, 'utf8')), body };
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async put(path, body) {
      const key = keyOf(path);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        }),
      );
    },
  };
}

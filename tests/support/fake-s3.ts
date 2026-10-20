/**
 * 偽の S3（テスト用）。S3 のクライアントの `send` だけを持つ。実際の AWS には、接続しない。
 * 再現している範囲: オブジェクトの一覧（接頭辞・区切り文字 `/`・1 回の件数の上限と、続きの取得）、オブジェクトの取得
 * （存在しないときは、実際の S3 と同じ名前 `NoSuchKey` のエラー）、接続できない状態。
 * AWS SDK は、`src/backend` の依存で、`tests/` からは読み込めないため、コマンドは、クラス名で見分ける。
 */

export interface FakeS3Options {
  readonly bucket: string;
  /** 一覧の 1 回の件数の上限（実際の S3 は 1,000）。続きの取得を、少ない件数で試すために、変えられる。 */
  readonly pageSize?: number;
}

interface FakeObject {
  readonly content: string;
  readonly modifiedAt: Date;
}

export interface RecordedS3Call {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

class FakeS3Error extends Error {
  readonly $metadata: { readonly httpStatusCode: number };

  constructor(name: string, statusCode: number) {
    super(name);
    this.name = name;
    this.$metadata = { httpStatusCode: statusCode };
  }
}

export function createFakeS3(options: FakeS3Options) {
  const pageSize = options.pageSize ?? 1000;
  const objects = new Map<string, FakeObject>();
  const calls: RecordedS3Call[] = [];
  let down = false;
  let failDelete = false;

  function assertBucket(input: Record<string, unknown>): void {
    if (input.Bucket !== options.bucket) {
      throw new FakeS3Error('NoSuchBucket', 404);
    }
  }

  function list(input: Record<string, unknown>) {
    const prefix = typeof input.Prefix === 'string' ? input.Prefix : '';
    const maxKeys = typeof input.MaxKeys === 'number' ? input.MaxKeys : pageSize;
    // 続きの取得の印は、実際の S3 と同じく、「直前の最後のキー」（その次から返す）。位置で数えると、削除しながら一覧したとき、取りこぼす
    const after = typeof input.ContinuationToken === 'string' ? input.ContinuationToken : undefined;
    const keys = [...objects.keys()]
      .filter((key) => key.startsWith(prefix))
      // 区切り文字（/）を指定したときは、接頭辞の直下のオブジェクトだけを返す（それより深いものは、まとめられる）
      .filter((key) => input.Delimiter !== '/' || !key.slice(prefix.length).includes('/'))
      .sort();
    const remaining = after === undefined ? keys : keys.filter((key) => key > after);
    const page = remaining.slice(0, Math.min(maxKeys, pageSize));
    const truncated = remaining.length > page.length;
    return {
      Contents: page.map((key) => {
        const object = objects.get(key);
        return {
          Key: key,
          LastModified: object?.modifiedAt,
          Size: Buffer.byteLength(object?.content ?? ''),
        };
      }),
      IsTruncated: truncated,
      ...(truncated ? { NextContinuationToken: page[page.length - 1] } : {}),
    };
  }

  function get(input: Record<string, unknown>) {
    const object = objects.get(String(input.Key));
    if (object === undefined) {
      throw new FakeS3Error('NoSuchKey', 404);
    }
    return { Body: { transformToString: () => Promise.resolve(object.content) } };
  }

  function deleteObjects(input: Record<string, unknown>) {
    const targets = (input.Delete as { Objects: { Key: string }[] }).Objects;
    if (failDelete) {
      return { Errors: targets.map((target) => ({ Key: target.Key, Code: 'AccessDenied' })) };
    }
    for (const target of targets) {
      objects.delete(target.Key);
    }
    return {};
  }

  return {
    calls,
    /** 保存されているオブジェクトのキー（古い順ではなく、並べ替えて返す）。 */
    keys(): string[] {
      return [...objects.keys()].sort();
    },
    /** 一括削除を、失敗（一部のオブジェクトを消せない）にする。 */
    failDeletes(): void {
      failDelete = true;
    },
    /** オブジェクトを置く（キーは、`<取り込み元>/<ファイル>`）。 */
    putObject(key: string, content: string, modifiedAt: Date): void {
      objects.set(key, { content, modifiedAt });
    },
    /** 接続できない状態にする（すべての呼び出しが、失敗する）。 */
    setDown(): void {
      down = true;
    },
    send(command: {
      readonly constructor: { readonly name: string };
      readonly input: unknown;
    }): Promise<unknown> {
      const name = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      calls.push({ command: name, input });
      if (down) {
        return Promise.reject(new FakeS3Error('TimeoutError', 500));
      }
      try {
        assertBucket(input);
        switch (name) {
          case 'ListObjectsV2Command':
            return Promise.resolve(list(input));
          case 'GetObjectCommand':
            return Promise.resolve(get(input));
          case 'DeleteObjectsCommand':
            return Promise.resolve(deleteObjects(input));
          default:
            return Promise.reject(new FakeS3Error('NotImplemented', 501));
        }
      } catch (error) {
        // assertBucket・list・get が投げるのは、FakeS3Error のみ
        return Promise.reject(error instanceof Error ? error : new FakeS3Error('Unknown', 500));
      }
    },
  };
}

export type FakeS3 = ReturnType<typeof createFakeS3>;

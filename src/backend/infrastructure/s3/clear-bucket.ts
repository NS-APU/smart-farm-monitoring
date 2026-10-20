/**
 * ファイルサーバーのモックの S3 のバケットを、空にする（Issue #77。ADR-0012）。デモデータのリセット（`pnpm demo-data reset`）で、
 * DynamoDB のデータと一緒に消す（残すと、取り込みのジョブが、古い合成ファイルから、観測値を作り直してしまう）。
 * バケットそのもの・設定は、消さない。手元のコマンドからだけ使う（API・Lambda の権限には、削除がない）。
 */

import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

/**
 * バケットのオブジェクトを、すべて消す。`dryRun` なら、消さずに、件数だけを数える。消した（数えた）件数を返す。
 * 1 回の一覧の件数（最大 1,000）ごとに、続きを取りながら、まとめて消す。
 */
export async function clearBucket(
  client: Pick<S3Client, 'send'>,
  bucket: string,
  options: { readonly dryRun?: boolean } = {},
): Promise<number> {
  const dryRun = options.dryRun ?? false;
  let count = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(token === undefined ? {} : { ContinuationToken: token }),
      }),
    );
    const keys = (page.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (keys.length > 0 && !dryRun) {
      const result = await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
      );
      // 一部を消せなかった（権限・競合など）ときは、成功とみなさず、エラーにする（残ったファイルが、取り込まれ続けるため）
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error('S3 のファイルの一部を、削除できませんでした');
      }
    }
    count += keys.length;
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return count;
}

/** DynamoDB のクライアントの作成。AWS では、Lambda の実行ロールの認証情報とリージョンを使う（何も指定しない）。 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DocumentClientOptions {
  readonly region?: string | undefined;
  /** DynamoDB Local など、別のエンドポイント（テスト・ローカルの開発用）。 */
  readonly endpoint?: string | undefined;
  /** 明示する認証情報（DynamoDB Local の、ダミーの値など）。AWS では、指定しない。 */
  readonly credentials?:
    { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined;
}

export function createDocumentClient(options: DocumentClientOptions = {}): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
  // 値が undefined の属性は、保存しない（省略できる項目）
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

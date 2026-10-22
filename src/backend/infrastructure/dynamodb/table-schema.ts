/**
 * DynamoDB のテーブルの定義（ADR-0007）。キーの属性名・インデックス名は、アダプタが使う。
 * テーブルの作成（DynamoDB Local のテスト）にも使う。AWS のテーブルは、IaC（infra/）で作る（同じキーにする）。
 */

import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/** テーブル名。観測値の専用のテーブルと、そのほかのテーブル。 */
export interface TableNames {
  readonly observations: string;
  readonly main: string;
}

/** Observations の疎なインデックス（手動入力だけ）。キーは `g2`（設備）・`g2s`（計測日時 + 項目）。 */
export const OBSERVATIONS_MANUAL_INDEX = 'manual';

/** Main の汎用のインデックス。キーは `gsi1pk`・`gsi1sk`。連携の未送信と、配信が未完了の通知（どちらも疎）に使う。 */
export const MAIN_INDEX_1 = 'gsi1';

export function observationsTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'g2', AttributeType: 'S' },
      { AttributeName: 'g2s', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: OBSERVATIONS_MANUAL_INDEX,
        KeySchema: [
          { AttributeName: 'g2', KeyType: 'HASH' },
          { AttributeName: 'g2s', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

export function mainTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'gsi1pk', AttributeType: 'S' },
      { AttributeName: 'gsi1sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: MAIN_INDEX_1,
        KeySchema: [
          { AttributeName: 'gsi1pk', KeyType: 'HASH' },
          { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  };
}

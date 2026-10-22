/**
 * テーブルの作成・削除（DynamoDB Local のテスト・ローカルの開発用）。
 * AWS のテーブルは、IaC（infra/）で作る。この関数は、AWS のテーブルには使わない。
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import type { DocumentClientOptions } from './client.ts';
import {
  mainTableDefinition,
  observationsTableDefinition,
  type TableNames,
} from './table-schema.ts';

function adminClient(options: DocumentClientOptions): DynamoDBClient {
  return new DynamoDBClient({
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}

/** テーブルを作る。すでにあれば、そのまま使う。 */
export async function createTables(
  options: DocumentClientOptions,
  tables: TableNames,
): Promise<void> {
  const client = adminClient(options);
  try {
    await Promise.all(
      [observationsTableDefinition(tables.observations), mainTableDefinition(tables.main)].map(
        async (definition) => {
          try {
            await client.send(new CreateTableCommand(definition));
          } catch (error) {
            if (!(error instanceof ResourceInUseException)) {
              throw error;
            }
          }
        },
      ),
    );
  } finally {
    client.destroy();
  }
}

/** テーブルを消す（なければ、何もしない）。 */
export async function deleteTables(
  options: DocumentClientOptions,
  tables: readonly TableNames[],
): Promise<void> {
  const client = adminClient(options);
  try {
    await Promise.allSettled(
      tables
        .flatMap((names) => [names.observations, names.main])
        .map((name) => client.send(new DeleteTableCommand({ TableName: name }))),
    );
  } finally {
    client.destroy();
  }
}

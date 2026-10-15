/**
 * DynamoDB アダプタのテスト用の補助。テストごとに、名前が重複しないテーブルを作り、後で消す。
 * 認証情報は、DynamoDB Local 用の、明らかにダミーの値（英数字のみ。ハイフンを含むと、DynamoDB Local が拒否する）。
 */

import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { Repositories } from '../../src/backend/application/ports/repositories.ts';
import {
  createDocumentClient,
  type DocumentClientOptions,
} from '../../src/backend/infrastructure/dynamodb/client.ts';
import { createDynamoRepositories } from '../../src/backend/infrastructure/dynamodb/dynamodb-repositories.ts';
import {
  createTables,
  deleteTables,
} from '../../src/backend/infrastructure/dynamodb/table-admin.ts';
import type { TableNames } from '../../src/backend/infrastructure/dynamodb/table-schema.ts';

const DUMMY_CREDENTIALS = { accessKeyId: 'localdummykey', secretAccessKey: 'localdummysecret' };
const REGION = 'ap-northeast-1';

export interface DynamoTestDatabase {
  readonly client: ReturnType<typeof createDocumentClient>;
  readonly tables: TableNames;
  /** テーブルの作成が終わったら解決する。 */
  readonly ready: Promise<void>;
}

const created: TableNames[] = [];

export function dynamoTestClientOptions(): DocumentClientOptions {
  const endpoint = inject('dynamodbEndpoint');
  if (endpoint === undefined) {
    throw new Error(
      'DynamoDB Local の接続先がありません。環境変数 DYNAMODB_ENDPOINT（起動済みの接続先）または DYNAMODB_LOCAL_DIR（DynamoDBLocal.jar のディレクトリ）を設定してください（docs/00_project/commands.md）',
    );
  }
  return { region: REGION, endpoint, credentials: DUMMY_CREDENTIALS };
}

/** 新しい（空の）テーブルの組を作る。作成は、非同期に進む（ready）。 */
export function createDynamoTestDatabase(): DynamoTestDatabase {
  const options = dynamoTestClientOptions();
  const id = randomUUID().replaceAll('-', '');
  const tables: TableNames = { observations: `test${id}obs`, main: `test${id}main` };
  created.push(tables);
  return { client: createDocumentClient(options), tables, ready: createTables(options, tables) };
}

/** 作ったテーブルを、すべて消す（共有の DynamoDB Local に、残さない）。 */
export async function dropDynamoTestTables(): Promise<void> {
  if (inject('dynamodbEndpoint') === undefined) {
    return;
  }
  await deleteTables(dynamoTestClientOptions(), created.splice(0));
}

/**
 * Repositories の各メソッドを、テーブルの作成が終わってから実行するようにする
 * （契約テストの create() は同期のため、作成の完了を、呼び出しの側で待てない）。
 */
export function whenReady(repositories: Repositories, ready: Promise<void>): Repositories {
  const wrapped: Record<string, unknown> = {};
  for (const [name, repository] of Object.entries(repositories)) {
    const methods: Record<string, unknown> = {};
    for (const [method, implementation] of Object.entries(repository as Record<string, unknown>)) {
      const call = implementation as (...args: unknown[]) => Promise<unknown>;
      methods[method] = async (...args: unknown[]) => {
        await ready;
        return call.apply(repository, args);
      };
    }
    wrapped[name] = methods;
  }
  return wrapped as unknown as Repositories;
}

/** 契約テスト用: 新しい（空の）DynamoDB の Repositories。 */
export function createDynamoRepositoriesForTest(): Repositories {
  const database = createDynamoTestDatabase();
  return whenReady(
    createDynamoRepositories({ client: database.client, tables: database.tables }),
    database.ready,
  );
}

/**
 * 評価環境のデモデータを、投入・リセットするコマンド（`pnpm demo-data seed` / `pnpm demo-data reset --yes`。Issue #77。ADR-0012）。
 * 本番の組み立て（Lambda）は、`SEED_MODE`・開発用 API を使えない（ADR-0009）。代わりに、運用者が、AWS のプロファイルを指定して、
 * 手元で実行する（`pnpm initial-user` と同じ方式。公開の URL からは、呼べない）。
 *
 * - `seed [--days N]`: デモの設備（ハウス 1・ロボット 1・環境センサー 1）・直近 N 日分（既定 3 日。1〜31）の合成データ・手入力の例を作り、評価する。
 *   ローカルの `SEED_MODE=DEMO` と同じ内容。設備がすでにあれば、何もしない（何度実行しても、既存のデータを上書きしない）。
 *   `--days 30` は、1 か月分の推移の表示の実測用（Issue #79。実測のあとは、reset のあと、既定の日数で投入し直せる）
 * - `reset`: ユーザー・ログインの試行回数の記録・ジョブのロック以外の、すべてのデータ（DynamoDB の観測値・設備・評価・通知・設定など）と、
 *   ファイルサーバーのモックの S3 のファイルを、消す。**元に戻せない**ため、`--yes` を付けないと、何も消さずに、対象の件数を示す
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあり、チャット・Issue・PR に貼らないため）
 *
 * 環境変数: `PERSISTENCE=dynamodb`・`DYNAMODB_OBSERVATIONS_TABLE`・`DYNAMODB_MAIN_TABLE`（値は、SfmData のスタックの出力）。
 * `reset` で S3 のファイルも消すときは、`FILE_SERVER_S3_BUCKET`（SfmEvaluation の出力 `FileServerBucketName`）。AWS_REGION の既定は ap-northeast-1。
 */

import { S3Client } from '@aws-sdk/client-s3';
import { AppError } from '@smart-farm/shared/errors';
import { createDocumentClient } from '../infrastructure/dynamodb/client.ts';
import { KEPT_PARTITIONS, resetData } from '../infrastructure/dynamodb/data-reset.ts';
import { clearBucket } from '../infrastructure/s3/clear-bucket.ts';
import { ConfigError, MAX_DEMO_SEED_DAYS, parseConfig, type AppConfig } from './config.ts';
import { createContainer, dynamoClientOptions, type ContainerOverrides } from './container.ts';

export interface CommandOutput {
  info(message: string): void;
  error(message: string): void;
}

const DEFAULT_REGION = 'ap-northeast-1';
const INITIAL_USER_KEYS = [
  'INITIAL_USER_ID',
  'INITIAL_USER_NAME',
  'INITIAL_USER_PASSWORD',
  'INITIAL_USER_ROLE',
] as const;
const USAGE = '使い方: pnpm demo-data seed [--days 日数] ／ pnpm demo-data reset [--yes]';

type Env = Readonly<Record<string, string | undefined>>;

/** INITIAL_USER_*（最初のユーザーを作るコマンドの設定）を除く。残っていても、このコマンドは使わない。 */
function withoutInitialUser(env: Env): Env {
  const excluded: readonly string[] = INITIAL_USER_KEYS;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !excluded.includes(key)));
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・テーブル名・バケット名の設定を確認してください`;
}

function loadConfig(
  env: Env,
  seedMode: 'NONE' | 'DEMO',
): AppConfig & { dynamodb: NonNullable<AppConfig['dynamodb']> } {
  const config = parseConfig({
    AWS_REGION: DEFAULT_REGION,
    ...withoutInitialUser(env),
    SEED_MODE: seedMode,
  });
  if (config.dynamodb === undefined) {
    throw new ConfigError(
      'PERSISTENCE=dynamodb・DYNAMODB_OBSERVATIONS_TABLE・DYNAMODB_MAIN_TABLE の設定が必要です',
    );
  }
  return { ...config, dynamodb: config.dynamodb };
}

/** `--days N` の値（指定がなければ、undefined）。不正な値は、黙って無視せず、エラーにする。 */
function parseDays(args: readonly string[]): string | undefined {
  const index = args.indexOf('--days');
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_DEMO_SEED_DAYS
  ) {
    throw new ConfigError(`--days には、1〜${String(MAX_DEMO_SEED_DAYS)} の整数を指定してください`);
  }
  return value;
}

async function seed(
  args: readonly string[],
  env: Env,
  output: CommandOutput,
  overrides: ContainerOverrides,
): Promise<void> {
  const days = parseDays(args);
  const config = loadConfig(days === undefined ? env : { ...env, DEMO_SEED_DAYS: days }, 'DEMO');
  const container = createContainer(config, overrides);
  try {
    const before = (await container.repositories.equipment.list({ includeDeleted: true })).length;
    // 初期データ（ステータスコード）と、デモデータ（設備がなければ）を用意する
    await container.initialize();
    const after = (await container.repositories.equipment.list({ includeDeleted: true })).length;
    output.info(
      before > 0
        ? `設備がすでに ${String(before)} 件あるため、デモデータは、投入しませんでした（消して、投入し直すときは、reset のあと、seed）`
        : `デモデータを投入しました（設備 ${String(after)} 件・直近 ${String(config.demoSeedDays)} 日分の合成データ・評価）`,
    );
  } finally {
    container.close();
  }
}

async function reset(
  args: readonly string[],
  env: Env,
  output: CommandOutput,
  overrides: ContainerOverrides,
): Promise<void> {
  const config = loadConfig(env, 'NONE');
  const confirmed = args.includes('--yes');
  const db = {
    client: createDocumentClient(dynamoClientOptions(config.dynamodb)),
    tables: {
      observations: config.dynamodb.observationsTable,
      main: config.dynamodb.mainTable,
    },
  };
  const s3 =
    config.fileServerBucket === undefined
      ? undefined
      : {
          client: overrides.s3Client ?? new S3Client({ region: DEFAULT_REGION }),
          bucket: config.fileServerBucket,
        };
  try {
    // S3 のファイルを先に消す（DynamoDB を先に消すと、その間に、取り込みのジョブが、古いファイルから、観測値を作り直すため）
    const files =
      s3 === undefined ? 0 : await clearBucket(s3.client, s3.bucket, { dryRun: !confirmed });
    const result = await resetData(db, { dryRun: !confirmed });
    const summary = `観測値 ${String(result.observations)} 件・そのほかのデータ ${String(result.main)} 件（${KEPT_PARTITIONS.join('・')} を除く）${s3 === undefined ? '' : `・S3 のファイル ${String(files)} 件`}`;
    if (!confirmed) {
      output.info(
        `reset は、${summary}を削除します。元に戻せません（必要なら、先に、バックアップを取ります）。実行するには、--yes を付けます`,
      );
      return;
    }
    // ステータスコードの初期データを、入れ直す（消えるため。設備・観測値は、入れない）
    const container = createContainer(config, overrides);
    try {
      await container.initialize();
    } finally {
      container.close();
    }
    output.info(`${summary}を削除しました。続けて、pnpm demo-data seed で、投入し直せます`);
  } finally {
    db.client.destroy();
  }
}

export async function runDemoDataCli(
  args: readonly string[],
  env: Env,
  output: CommandOutput,
  overrides: ContainerOverrides = {},
): Promise<number> {
  const [command] = args;
  if (command !== 'seed' && command !== 'reset') {
    output.error(`コマンドを指定してください。${USAGE}`);
    return 1;
  }
  try {
    if (command === 'seed') {
      await seed(args, env, output, overrides);
    } else {
      await reset(args, env, output, overrides);
    }
    return 0;
  } catch (error) {
    output.error(`demo-data ${command} に失敗しました: ${describeFailure(error)}`);
    return 1;
  }
}

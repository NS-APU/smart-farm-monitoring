/**
 * 実行設定（環境変数）。起動時にスキーマで検証し、ハンドラの中で直接 `process.env` を参照しない
 * （coding-standards.md）。変数名とダミー値は、リポジトリ直下の `.env.example` にある。
 * 検証のエラーには、変数名だけを含め、値を含めない（秘密情報の漏えいを防ぐ）。
 */

import { z } from 'zod';
import { PERMISSIONS } from '@smart-farm/shared/constants/permissions';
import type { IngestionIntervalMinutes } from '@smart-farm/shared/constants/status';
import { findPasswordPolicyViolation } from '@smart-farm/shared/schemas/auth';
import { UserIdSchema } from '@smart-farm/shared/schemas/common';
import { IngestionIntervalSchema } from '@smart-farm/shared/schemas/ingestion';
import { DEFAULT_ROLE_CONFIG, type RoleConfig } from '../application/auth/access-policy.ts';
import { SEED_MODES, type SeedMode } from '../application/seed/seed-modes.ts';
import { LOG_LEVELS, type LogLevel } from '../infrastructure/logging/json-logger.ts';
import { namedErrorClass } from '../application/named-error.ts';

export const APP_MODES = ['local', 'test', 'production'] as const;
export type AppMode = (typeof APP_MODES)[number];

/** 永続化の方式。memory: メモリのみ／file: JSON ファイル／dynamodb: DynamoDB（ADR-0007）。 */
export const PERSISTENCE_MODES = ['memory', 'file', 'dynamodb'] as const;
export type PersistenceMode = (typeof PERSISTENCE_MODES)[number];

/** 認証の方式。local: アプリ内のユーザーID・パスワード／cognito: Amazon Cognito（ADR-0008）。 */
export const AUTH_PROVIDERS = ['local', 'cognito'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

const BooleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const RoleDefinitionsSchema = z.record(
  z.string().min(1),
  z.object({ name: z.string().min(1), permissions: z.array(z.enum(PERMISSIONS)) }),
);

/** 信頼するプロキシの段数の上限（これを超える段数は、設定の誤りとみなす）。 */
const MAX_TRUSTED_PROXY_HOPS = 10;

const EnvSchema = z.object({
  APP_MODE: z.enum(APP_MODES).default('local'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  PERSISTENCE: z.enum(PERSISTENCE_MODES).default('memory'),
  DATA_FILE: z.string().min(1).default('.local-data/store.json'),
  /** DynamoDB のテーブル名（PERSISTENCE=dynamodb で必須）。AWS のテーブルは、IaC（infra/）が作る。 */
  DYNAMODB_OBSERVATIONS_TABLE: z.string().min(1).optional(),
  DYNAMODB_MAIN_TABLE: z.string().min(1).optional(),
  /** DynamoDB の接続先（DynamoDB Local など、ローカルの開発用）。指定すると、起動時にテーブルを作る。AWS では指定しない。 */
  DYNAMODB_ENDPOINT: z.url().optional(),
  /** 認証の方式。cognito は、PERSISTENCE=dynamodb が必要（ユーザーのロールを DynamoDB に持つ）。 */
  AUTH_PROVIDER: z.enum(AUTH_PROVIDERS).default('local'),
  /** Cognito のユーザープール・アプリクライアントの ID（AUTH_PROVIDER=cognito で必須。IaC の SfmData の出力）。 */
  COGNITO_USER_POOL_ID: z.string().min(1).optional(),
  COGNITO_CLIENT_ID: z.string().min(1).optional(),
  /** AWS のリージョン（Lambda では、実行環境が設定する）。 */
  AWS_REGION: z.string().min(1).optional(),
  /** ファイルサーバーのモックのルート。`<ルート>/<取り込み元>/` に合成データのファイルを置く。 */
  FILE_SERVER_DIR: z.string().min(1).default('.local-data/file-server'),
  SEED_MODE: z.enum(SEED_MODES).default('NONE'),
  INITIAL_USER_ID: z.string().min(1).optional(),
  INITIAL_USER_NAME: z.string().min(1).optional(),
  INITIAL_USER_PASSWORD: z.string().min(1).optional(),
  /** ロール定義（JSON）。未指定なら、1ロール（農作業者。全権限）。 */
  ROLE_DEFINITIONS_JSON: z.string().min(1).optional(),
  INITIAL_USER_ROLE: z.string().min(1).optional(),
  SCHEDULER_ENABLED: BooleanFromString.default(false),
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(1).default(30),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DEFAULT_INGESTION_INTERVAL_MINUTES: z.coerce.number().pipe(IngestionIntervalSchema).default(15),
  STALE_AFTER_INTERVALS: z.coerce.number().min(1).default(3),
  INGESTION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  /** ファイル単位の失敗（読み取り不可・形式違い・大きすぎる）も、取り込み失敗として通知するか（V-017。既定は通知しない）。 */
  INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED: BooleanFromString.default(false),
  /** 新しいデータが届かない取り込み元を、「データ取得の停止」として通知するか（V-018。暫定仕様）。 */
  INGESTION_STOP_NOTIFICATION_ENABLED: BooleanFromString.default(true),
  /** Web Push の購読に使う公開鍵（VAPID）。未指定なら、Web Push の購読を受け付けない（画面内の通知のみ）。 */
  WEB_PUSH_PUBLIC_KEY: z.string().min(1).optional(),
  /**
   * 開発用 API（時計・モック・リセット・ジョブの強制実行）を有効にするか。既定は無効。
   * E2E・負荷テストの設定で、明示的に有効にする。本番（production）では、指定にかかわらず無効（V-001）。
   */
  DEV_API_ENABLED: BooleanFromString.default(false),
  /**
   * 信頼するプロキシの段数。0（既定）なら、X-Forwarded-For を信頼せず、接続情報の接続元を使う。
   * N なら、X-Forwarded-For の末尾から N 番目（信頼するプロキシが付けた値）を、接続元とみなす（V-007）。
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(MAX_TRUSTED_PROXY_HOPS).default(0),
});

/** DynamoDB の接続の設定（PERSISTENCE=dynamodb のとき）。 */
export interface DynamoDbConfig {
  readonly observationsTable: string;
  readonly mainTable: string;
  /** 別の接続先（DynamoDB Local など）。AWS では undefined。 */
  readonly endpoint: string | undefined;
  readonly region: string | undefined;
}

/** Cognito の接続の設定（AUTH_PROVIDER=cognito のとき）。 */
export interface CognitoConfig {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly region: string | undefined;
}

export interface InitialUserConfig {
  readonly userId: string;
  readonly userName: string;
  readonly password: string;
  readonly role: string;
}

export interface AppConfig {
  readonly mode: AppMode;
  readonly host: string;
  readonly port: number;
  readonly persistence: PersistenceMode;
  readonly dataFile: string;
  /** PERSISTENCE=dynamodb のときだけ。 */
  readonly dynamodb: DynamoDbConfig | undefined;
  /** AUTH_PROVIDER=cognito のときだけ。 */
  readonly cognito: CognitoConfig | undefined;
  readonly fileServerDirectory: string;
  readonly seedMode: SeedMode;
  readonly initialUser: InitialUserConfig | undefined;
  readonly roles: RoleConfig;
  readonly schedulerEnabled: boolean;
  readonly schedulerTickSeconds: number;
  readonly logLevel: LogLevel;
  readonly defaultIngestionIntervalMinutes: IngestionIntervalMinutes;
  readonly staleAfterIntervals: number;
  readonly ingestionRetryBaseDelayMs: number;
  readonly ingestionStopNotificationEnabled: boolean;
  readonly ingestionFileFailureNotificationEnabled: boolean;
  readonly webPushPublicKey: string | undefined;
  /** 開発用の API（時計・モック・リセット）を有効にするか。環境変数で明示したときだけ有効で、本番では常に無効。 */
  readonly devApiEnabled: boolean;
  /** 信頼するプロキシの段数（接続元の識別。0 なら X-Forwarded-For を信頼しない）。 */
  readonly trustedProxyHops: number;
}

export class ConfigError extends namedErrorClass('ConfigError') {}

function parseRoles(json: string | undefined): RoleConfig {
  if (json === undefined) {
    return DEFAULT_ROLE_CONFIG;
  }
  try {
    return RoleDefinitionsSchema.parse(JSON.parse(json));
  } catch (error) {
    throw new ConfigError('ROLE_DEFINITIONS_JSON の形式が正しくありません', { cause: error });
  }
}

function parseInitialUser(
  env: z.infer<typeof EnvSchema>,
  roles: RoleConfig,
): InitialUserConfig | undefined {
  const {
    INITIAL_USER_ID: userId,
    INITIAL_USER_NAME: userName,
    INITIAL_USER_PASSWORD: password,
  } = env;
  if (userId === undefined && userName === undefined && password === undefined) {
    return undefined;
  }
  if (userId === undefined || userName === undefined || password === undefined) {
    throw new ConfigError(
      'INITIAL_USER_ID / INITIAL_USER_NAME / INITIAL_USER_PASSWORD は、すべて指定してください',
    );
  }
  if (!UserIdSchema.safeParse(userId).success) {
    throw new ConfigError('INITIAL_USER_ID の形式が正しくありません');
  }
  if (findPasswordPolicyViolation(password) !== null) {
    throw new ConfigError('INITIAL_USER_PASSWORD がパスワードの条件を満たしていません');
  }
  // 省略時は、ユーザー管理の権限を持つ最初のロール（記述の順序で、ユーザーを管理できない初期ユーザーになることを防ぐ）
  const role =
    env.INITIAL_USER_ROLE ??
    Object.entries(roles).find(([, definition]) =>
      definition.permissions.includes('user:manage'),
    )?.[0];
  if (role === undefined || !Object.hasOwn(roles, role)) {
    throw new ConfigError('INITIAL_USER_ROLE が、ロール定義にありません');
  }
  return { userId, userName, password, role };
}

function parseDynamoDb(parsed: z.infer<typeof EnvSchema>): DynamoDbConfig | undefined {
  if (parsed.PERSISTENCE !== 'dynamodb') {
    return undefined;
  }
  if (
    parsed.DYNAMODB_OBSERVATIONS_TABLE === undefined ||
    parsed.DYNAMODB_MAIN_TABLE === undefined
  ) {
    throw new ConfigError(
      'PERSISTENCE=dynamodb では、DYNAMODB_OBSERVATIONS_TABLE と DYNAMODB_MAIN_TABLE の指定が必要です',
    );
  }
  if (parsed.DEV_API_ENABLED) {
    // 開発用 API のリセットは、全データを消す。DynamoDB のデータを、消さないようにする
    throw new ConfigError('PERSISTENCE=dynamodb では、DEV_API_ENABLED は使えません');
  }
  return {
    observationsTable: parsed.DYNAMODB_OBSERVATIONS_TABLE,
    mainTable: parsed.DYNAMODB_MAIN_TABLE,
    endpoint: parsed.DYNAMODB_ENDPOINT,
    region: parsed.AWS_REGION,
  };
}

function parseCognito(parsed: z.infer<typeof EnvSchema>): CognitoConfig | undefined {
  if (parsed.AUTH_PROVIDER !== 'cognito') {
    return undefined;
  }
  if (parsed.COGNITO_USER_POOL_ID === undefined || parsed.COGNITO_CLIENT_ID === undefined) {
    throw new ConfigError(
      'AUTH_PROVIDER=cognito では、COGNITO_USER_POOL_ID と COGNITO_CLIENT_ID の指定が必要です',
    );
  }
  if (parsed.PERSISTENCE !== 'dynamodb') {
    // ユーザーのロール・最終ログインは、DynamoDB の USER に持つ。ログインの試行回数の制限も、DynamoDB で共有する
    throw new ConfigError('AUTH_PROVIDER=cognito では、PERSISTENCE=dynamodb が必要です');
  }
  if (
    parsed.INITIAL_USER_ID !== undefined ||
    parsed.INITIAL_USER_NAME !== undefined ||
    parsed.INITIAL_USER_PASSWORD !== undefined
  ) {
    // 最初のユーザーは、起動のたびではなく、手元のスクリプトで 1 回だけ作る（パスワードを、環境変数・設定に残さない）
    throw new ConfigError(
      'AUTH_PROVIDER=cognito では、INITIAL_USER_* は使えません。最初のユーザーは、スクリプトで作ります（docs/00_project/commands.md）',
    );
  }
  return {
    userPoolId: parsed.COGNITO_USER_POOL_ID,
    clientId: parsed.COGNITO_CLIENT_ID,
    region: parsed.AWS_REGION,
  };
}

function parseEnv(env: Readonly<Record<string, string | undefined>>): z.infer<typeof EnvSchema> {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'ENV')))];
    throw new ConfigError(`環境変数の設定が正しくありません: ${names.join(', ')}`);
  }
  return result.data;
}

/**
 * 環境変数の INITIAL_USER_* だけを読む（最初のユーザーを作るコマンド用。ほかの設定の検証は、parseConfig が行う）。
 * 指定がなければ undefined。
 */
export function parseInitialUserEnv(
  env: Readonly<Record<string, string | undefined>>,
  roles: RoleConfig,
): InitialUserConfig | undefined {
  return parseInitialUser(parseEnv(env), roles);
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = parseEnv(env);
  const roles = parseRoles(parsed.ROLE_DEFINITIONS_JSON);
  return {
    mode: parsed.APP_MODE,
    host: parsed.HOST,
    port: parsed.PORT,
    persistence: parsed.PERSISTENCE,
    dataFile: parsed.DATA_FILE,
    dynamodb: parseDynamoDb(parsed),
    cognito: parseCognito(parsed),
    fileServerDirectory: parsed.FILE_SERVER_DIR,
    seedMode: parsed.SEED_MODE,
    initialUser: parseInitialUser(parsed, roles),
    roles,
    schedulerEnabled: parsed.SCHEDULER_ENABLED,
    schedulerTickSeconds: parsed.SCHEDULER_TICK_SECONDS,
    logLevel: parsed.LOG_LEVEL,
    defaultIngestionIntervalMinutes: parsed.DEFAULT_INGESTION_INTERVAL_MINUTES,
    staleAfterIntervals: parsed.STALE_AFTER_INTERVALS,
    ingestionRetryBaseDelayMs: parsed.INGESTION_RETRY_BASE_DELAY_MS,
    ingestionStopNotificationEnabled: parsed.INGESTION_STOP_NOTIFICATION_ENABLED,
    ingestionFileFailureNotificationEnabled: parsed.INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED,
    webPushPublicKey: parsed.WEB_PUSH_PUBLIC_KEY,
    devApiEnabled: parsed.DEV_API_ENABLED && parsed.APP_MODE !== 'production',
    trustedProxyHops: parsed.TRUSTED_PROXY_HOPS,
  };
}

/**
 * Lambda の入口の設定。環境変数の既定（local・メモリ）で動かさず、`APP_MODE`・`PERSISTENCE` の明示を必須にする
 * （設定の漏れが、開発用 API の露出・データの消失として表れることを防ぐ。V-002）。
 * ファイルの永続化は、読み取り専用のファイルシステム・複数の実行環境では使えないため、拒否する（V-133）。
 * 開発用 API は、指定にかかわらず無効にする（V-001）。
 */
export function parseLambdaConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  for (const name of ['APP_MODE', 'PERSISTENCE'] as const) {
    if (env[name] === undefined || env[name] === '') {
      throw new ConfigError(`Lambda では、環境変数 ${name} の指定が必須です`);
    }
  }
  const config = parseConfig(env);
  if (config.persistence === 'file') {
    throw new ConfigError(
      'Lambda では、PERSISTENCE=file は使えません（読み取り専用のファイルシステム・複数の実行環境のため）',
    );
  }
  if (config.mode === 'production' && config.persistence === 'memory') {
    throw new ConfigError(
      '本番の Lambda では、PERSISTENCE=memory は使えません（データが失われるため）',
    );
  }
  return { ...config, devApiEnabled: false };
}

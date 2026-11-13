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
import {
  EVALUATION_ON_WRITE_MODES,
  type EvaluationOnWrite,
} from '../application/evaluation/evaluation-on-write.ts';
import { SEED_MODES, type SeedMode } from '../application/seed/seed-modes.ts';
import {
  DEFAULT_FEDERATION_EXPIRY_DAYS,
  MAX_FEDERATION_EXPIRY_DAYS,
  MAX_FUTURE_TOLERANCE_MINUTES,
  MIN_FEDERATION_EXPIRY_DAYS,
} from '../application/settings.ts';
import { DEFAULT_FUTURE_TOLERANCE_MINUTES } from '../domain/observation-quality.ts';
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  MAX_LOGIN_FAILURE_LIMIT,
  MAX_LOGIN_FAILURE_WINDOW_MINUTES,
  MIN_LOGIN_FAILURE_LIMIT,
  MIN_LOGIN_FAILURE_WINDOW_MINUTES,
  type LoginFailurePolicy,
} from '../infrastructure/common/auth-policy.ts';
import { LOG_LEVELS, type LogLevel } from '../infrastructure/logging/json-logger.ts';
import { namedErrorClass } from '../application/named-error.ts';
import { ORIGIN_SECRET_PATTERN } from '../presentation/origin-guard.ts';

export const APP_MODES = ['local', 'test', 'production'] as const;

/** 農業情報基盤との連携の方式。 */
export const FEDERATION_MODES = ['mock', 'ngsi-ld'] as const;
export type FederationMode = (typeof FEDERATION_MODES)[number];
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

/** デモデータの合成データの日数の上限（約 1 か月。DynamoDB への書き込みの量を、限る）。 */
export const MAX_DEMO_SEED_DAYS = 31;

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
  /**
   * ファイルサーバーのモックの S3 のバケット名（Issue #77。ADR-0012）。指定すると、ローカルのディレクトリ（FILE_SERVER_DIR）ではなく、
   * S3 の `<バケット>/<取り込み元>/` を使う。Lambda には、ローカルのディレクトリがないため、評価環境は、これを指定する。
   */
  FILE_SERVER_S3_BUCKET: z.string().min(1).optional(),
  /**
   * 秘密情報（接続先の認証情報・Web Push の秘密鍵）の保管先（Issue #206。D-55）。memory = メモリ（ローカル・テスト）、
   * ssm = パラメータストア（SecureString。本番・開発サイト）。名前に SECRET・KEY を含めない（環境変数に、秘密情報を持たない検査のため）
   */
  CREDENTIAL_STORE: z.enum(['memory', 'ssm']).default('memory'),
  /** ssm のときの、パスの接頭辞（環境ごと。先頭と末尾が /。例: /sfm/development/）。 */
  CREDENTIAL_PATH_PREFIX: z
    .string()
    .regex(/^\/([a-z0-9][a-z0-9._-]*\/)+$/)
    .optional(),
  SEED_MODE: z.enum(SEED_MODES).default('NONE'),
  /**
   * 手動入力の保存・修正・削除の応答の前に、評価を再計算するか（Issue #123。ADR-0014）。`sync`（既定。ローカル・E2E）は、再計算する。
   * `deferred`（AWS の Lambda。IaC が指定する）は、再計算せず、定期の評価（JB-02）が更新する。
   */
  EVALUATION_ON_WRITE: z.enum(EVALUATION_ON_WRITE_MODES).default('sync'),
  /**
   * デモデータ（SEED_MODE=DEMO）の、合成データの日数（Issue #79）。既定は 3 日。1 か月分の推移の表示（NFR-3.5）を
   * 測るときは、`pnpm demo-data seed --days 30` で指定する（このコマンドが、この設定を渡す）。
   */
  DEMO_SEED_DAYS: z.coerce.number().int().min(1).max(MAX_DEMO_SEED_DAYS).default(3),
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
  /** 連携の破棄の期限（日）。積んでからこの日数を過ぎても送れていない項目は、破棄して、連携のログと通知に残す（D-06。既定は 30 日）。 */
  FEDERATION_EXPIRY_DAYS: z.coerce
    .number()
    .int()
    .min(MIN_FEDERATION_EXPIRY_DAYS)
    .max(MAX_FEDERATION_EXPIRY_DAYS)
    .default(DEFAULT_FEDERATION_EXPIRY_DAYS),
  /** 農業情報基盤との連携の方式（mock: モック〔ローカル・テスト〕／ngsi-ld: NGSI-LD のアダプタ。ADR-0024。#177）。 */
  FEDERATION_MODE: z.enum(FEDERATION_MODES).default('mock'),
  /** ファイル単位の失敗（読み取り不可・形式違い・大きすぎる）も、取り込み失敗として通知するか（V-017。既定は通知する。ADR-0019 の D-37）。 */
  INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED: BooleanFromString.default(true),
  /** 取り込みの計測日時の未来の許容（分。既定 5 分。受信より、これを超えて先の計測日時は、不正。手動入力は、5 分固定。D-13）。 */
  INGESTION_FUTURE_TOLERANCE_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_FUTURE_TOLERANCE_MINUTES)
    .default(DEFAULT_FUTURE_TOLERANCE_MINUTES),
  /** 新しいデータが届かない取り込み元を、「データ取得の停止」として通知するか（V-018。暫定仕様）。 */
  INGESTION_STOP_NOTIFICATION_ENABLED: BooleanFromString.default(true),
  /** Web Push の購読に使う公開鍵（VAPID）。未指定なら、Web Push の購読を受け付けない（画面内の通知のみ）。 */
  WEB_PUSH_PUBLIC_KEY: z.string().min(1).optional(),
  /**
   * Web Push の配信の方式（#241）。dummy（既定）: 実際には送らず、記録だけ（ローカル・テスト）。
   * vapid: プッシュサービスへ実際に送る（VAPID。秘密鍵は、秘密情報の web-push/vapid-private-key）。公開鍵・連絡先が必要。
   */
  WEB_PUSH_DELIVERY: z.enum(['dummy', 'vapid']).default('dummy'),
  /** Web Push の VAPID の連絡先（アプリの https の URL。個人のメールアドレスは、設定に持たない）。 */
  WEB_PUSH_SUBJECT: z
    .url({ protocol: /^https$/ })
    .max(500)
    .optional(),
  /**
   * 開発用 API（時計・モック・リセット・ジョブの強制実行）を有効にするか。既定は無効。
   * E2E・負荷テストの設定で、明示的に有効にする。本番（production）では、指定にかかわらず無効（V-001）。
   */
  DEV_API_ENABLED: BooleanFromString.default(false),
  /**
   * ファイルサーバー（HTTP）の接続先に、内部のアドレス（ループバック・プライベート・リンクローカル）を許可するか（Issue #172。ADR-0022）。
   * 既定は拒否（SSRF の対策）。ローカル・E2E・テストで、手元の HTTP サーバーに接続するときだけ指定する。本番（production）では、指定にかかわらず拒否。
   */
  HTTP_FILE_SOURCE_ALLOW_PRIVATE: BooleanFromString.default(false),
  /**
   * 信頼するプロキシの段数。0（既定）なら、X-Forwarded-For を信頼せず、接続情報の接続元を使う。
   * N なら、X-Forwarded-For の末尾から N 番目（信頼するプロキシが付けた値）を、接続元とみなす（V-007）。
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(MAX_TRUSTED_PROXY_HOPS).default(0),
  /**
   * 利用者の IP が入っているヘッダーの名前（小文字にして使う）。指定すると、そのヘッダーの値（IP として正しいときだけ）を、
   * 接続元とみなす。CloudFront の Function が入れる（関数の URL は、X-Forwarded-For を切り詰めるため、段数では識別できない。
   * Issue #100）。CloudFront を経由しない呼び出しでは、利用者が値を付けられる。
   */
  /**
   * 接続元ごとのログインの失敗の制限（FR-9.2。D-44）: 同じ接続元から、LOGIN_FAILURE_WINDOW_MINUTES 分のうちに、失敗が
   * LOGIN_FAILURE_LIMIT 回に達したら、一時的に拒否する。既定は、失敗 5 回 / 15 分。共有の IP で、誤ってロックされる事例が出たら、
   * コードを変えずに、回数・時間を変えられる。アカウント単位のロックは、Cognito に任せる（ADR-0008）。
   */
  LOGIN_FAILURE_LIMIT: z.coerce
    .number()
    .int()
    .min(MIN_LOGIN_FAILURE_LIMIT)
    .max(MAX_LOGIN_FAILURE_LIMIT)
    .default(LOGIN_FAILURE_LIMIT),
  LOGIN_FAILURE_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(MIN_LOGIN_FAILURE_WINDOW_MINUTES)
    .max(MAX_LOGIN_FAILURE_WINDOW_MINUTES)
    .default(LOGIN_FAILURE_WINDOW_MINUTES),
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'ヘッダー名（英数字とハイフン）で指定してください')
    .optional(),
  // CloudFront が、オリジンに付ける秘密のヘッダーの値（Issue #102）。ローカル・テストで、値を直接、渡す（Lambda では、使えない）。
  // エラーには、変数の名前だけを出す（値を含めない）
  ORIGIN_VERIFY_SECRET: z
    .string()
    .regex(ORIGIN_SECRET_PATTERN, '英数字 32〜128 文字で指定してください')
    .optional(),
  // 上の秘密の値を保管している Secrets Manager の秘密の ARN（秘密の値ではない）。API の Lambda が、コールドスタートで、読む（lambda.ts）
  ORIGIN_VERIFY_ARN: z
    .string()
    .regex(
      /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/,
      'Secrets Manager の秘密の ARN で指定してください',
    )
    .optional(),
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
  /** ファイルサーバーのモックの S3 のバケット名（指定すると、S3 を使う）。未指定なら、ローカルのディレクトリ。 */
  readonly fileServerBucket: string | undefined;
  /** 秘密情報の保管先。ssm のときは、パスの接頭辞が要る。 */
  readonly secrets: {
    readonly provider: 'memory' | 'ssm';
    readonly pathPrefix?: string;
  };
  readonly seedMode: SeedMode;
  /** 手動入力の保存・修正・削除の応答の前に、評価を再計算するか。 */
  readonly evaluationOnWrite: EvaluationOnWrite;
  /** デモデータの合成データの日数（SEED_MODE=DEMO のとき）。 */
  readonly demoSeedDays: number;
  readonly initialUser: InitialUserConfig | undefined;
  readonly roles: RoleConfig;
  readonly schedulerEnabled: boolean;
  readonly schedulerTickSeconds: number;
  readonly logLevel: LogLevel;
  readonly defaultIngestionIntervalMinutes: IngestionIntervalMinutes;
  readonly staleAfterIntervals: number;
  readonly ingestionRetryBaseDelayMs: number;
  readonly federationExpiryDays: number;
  readonly ingestionStopNotificationEnabled: boolean;
  readonly ingestionFileFailureNotificationEnabled: boolean;
  readonly ingestionFutureToleranceMinutes: number;
  readonly federationMode: FederationMode;
  readonly webPushPublicKey: string | undefined;
  /** Web Push の配信の方式（dummy: 記録だけ／vapid: 実際に送る）。 */
  readonly webPushDelivery: 'dummy' | 'vapid';
  /** VAPID の連絡先（https の URL）。vapid のときは必ずある。 */
  readonly webPushSubject: string | undefined;
  /** 開発用の API（時計・モック・リセット）を有効にするか。環境変数で明示したときだけ有効で、本番では常に無効。 */
  readonly devApiEnabled: boolean;
  /** ファイルサーバー（HTTP）の接続先に、内部のアドレスを許可するか（本番は、常に false）。 */
  readonly httpFileSourceAllowPrivate: boolean;
  /** 信頼するプロキシの段数（接続元の識別。0 なら X-Forwarded-For を信頼しない）。 */
  readonly trustedProxyHops: number;
  /** 利用者の IP が入っているヘッダーの名前（小文字。接続元の識別。未指定なら使わない）。 */
  readonly clientIpHeader: string | undefined;
  /**
   * CloudFront が、オリジンに付ける秘密のヘッダーの値（Issue #102）。指定があれば、API は、値が一致しない呼び出し（関数の URL の直接の呼び出し）を、
   * 403 で拒否する。未指定は、検証しない（ローカル・E2E）。API の Lambda は、本番では必須（lambda.ts）。
   */
  readonly originVerifySecret: string | undefined;
  /** オリジンの秘密を保管している Secrets Manager の秘密の ARN（秘密の値ではない）。API の Lambda が、実行時に読む（lambda.ts）。 */
  readonly originVerifyArn: string | undefined;
  /** 接続元ごとのログインの失敗の制限（失敗 `limit` 回 / `windowMinutes` 分。既定は 5 回 / 15 分。D-44）。 */
  readonly loginFailurePolicy: LoginFailurePolicy;
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

/** Web Push を実際に送る（vapid）には、公開鍵と連絡先が要る（足りないまま、起動しない）。 */
function assertWebPushDelivery(parsed: z.infer<typeof EnvSchema>): void {
  if (parsed.WEB_PUSH_DELIVERY !== 'vapid') {
    return;
  }
  for (const [name, value] of [
    ['WEB_PUSH_PUBLIC_KEY', parsed.WEB_PUSH_PUBLIC_KEY],
    ['WEB_PUSH_SUBJECT', parsed.WEB_PUSH_SUBJECT],
  ] as const) {
    if (value === undefined) {
      throw new ConfigError(`WEB_PUSH_DELIVERY=vapid では、${name} の指定が必要です`);
    }
  }
}

function parseSecrets(parsed: z.infer<typeof EnvSchema>): AppConfig['secrets'] {
  if (parsed.CREDENTIAL_STORE === 'memory') {
    return { provider: 'memory' };
  }
  if (parsed.CREDENTIAL_PATH_PREFIX === undefined) {
    throw new ConfigError('CREDENTIAL_STORE=ssm では、CREDENTIAL_PATH_PREFIX の指定が必要です');
  }
  return { provider: 'ssm', pathPrefix: parsed.CREDENTIAL_PATH_PREFIX };
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

/**
 * 本番（APP_MODE=production）の必須の設定（ADR-0009）。本番では、ユーザー・データを失う・分裂する構成（アプリ内の認証・
 * メモリ・ファイル）を使わない。認証は Cognito、データは DynamoDB。
 */
function assertProductionAdapters(
  mode: AppMode,
  cognito: CognitoConfig | undefined,
  dynamodb: DynamoDbConfig | undefined,
): void {
  if (mode !== 'production') {
    return;
  }
  if (cognito === undefined || dynamodb === undefined) {
    throw new ConfigError(
      'APP_MODE=production では、AUTH_PROVIDER=cognito と PERSISTENCE=dynamodb（と、それぞれの設定）が必要です',
    );
  }
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = parseEnv(env);
  const roles = parseRoles(parsed.ROLE_DEFINITIONS_JSON);
  const dynamodb = parseDynamoDb(parsed);
  const cognito = parseCognito(parsed);
  assertProductionAdapters(parsed.APP_MODE, cognito, dynamodb);
  assertWebPushDelivery(parsed);
  return {
    mode: parsed.APP_MODE,
    host: parsed.HOST,
    port: parsed.PORT,
    persistence: parsed.PERSISTENCE,
    dataFile: parsed.DATA_FILE,
    dynamodb,
    cognito,
    fileServerDirectory: parsed.FILE_SERVER_DIR,
    fileServerBucket: parsed.FILE_SERVER_S3_BUCKET,
    secrets: parseSecrets(parsed),
    seedMode: parsed.SEED_MODE,
    evaluationOnWrite: parsed.EVALUATION_ON_WRITE,
    demoSeedDays: parsed.DEMO_SEED_DAYS,
    initialUser: parseInitialUser(parsed, roles),
    roles,
    schedulerEnabled: parsed.SCHEDULER_ENABLED,
    schedulerTickSeconds: parsed.SCHEDULER_TICK_SECONDS,
    logLevel: parsed.LOG_LEVEL,
    defaultIngestionIntervalMinutes: parsed.DEFAULT_INGESTION_INTERVAL_MINUTES,
    staleAfterIntervals: parsed.STALE_AFTER_INTERVALS,
    ingestionRetryBaseDelayMs: parsed.INGESTION_RETRY_BASE_DELAY_MS,
    federationExpiryDays: parsed.FEDERATION_EXPIRY_DAYS,
    ingestionStopNotificationEnabled: parsed.INGESTION_STOP_NOTIFICATION_ENABLED,
    ingestionFileFailureNotificationEnabled: parsed.INGESTION_FILE_FAILURE_NOTIFICATION_ENABLED,
    ingestionFutureToleranceMinutes: parsed.INGESTION_FUTURE_TOLERANCE_MINUTES,
    federationMode: parsed.FEDERATION_MODE,
    webPushPublicKey: parsed.WEB_PUSH_PUBLIC_KEY,
    webPushDelivery: parsed.WEB_PUSH_DELIVERY,
    webPushSubject: parsed.WEB_PUSH_SUBJECT,
    devApiEnabled: parsed.DEV_API_ENABLED && parsed.APP_MODE !== 'production',
    httpFileSourceAllowPrivate:
      parsed.HTTP_FILE_SOURCE_ALLOW_PRIVATE && parsed.APP_MODE !== 'production',
    trustedProxyHops: parsed.TRUSTED_PROXY_HOPS,
    clientIpHeader: parsed.CLIENT_IP_HEADER,
    originVerifySecret: parsed.ORIGIN_VERIFY_SECRET,
    originVerifyArn: parsed.ORIGIN_VERIFY_ARN,
    loginFailurePolicy: {
      limit: parsed.LOGIN_FAILURE_LIMIT,
      windowMinutes: parsed.LOGIN_FAILURE_WINDOW_MINUTES,
    },
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
  if (config.seedMode !== 'NONE') {
    // 起動のたび（コールドスタートのたび）に、デモデータを投入しない。評価環境のデモデータは、別の入口で投入する（Issue #77）
    throw new ConfigError(
      'Lambda では、SEED_MODE は使えません（デモデータは、別の入口で投入します）',
    );
  }
  // 秘密の値は、Lambda の環境変数（設定）に持たない。Secrets Manager の ARN（ORIGIN_VERIFY_ARN）で指定し、実行時に読む（Issue #102）
  if (config.originVerifySecret !== undefined) {
    throw new ConfigError(
      'Lambda では、ORIGIN_VERIFY_SECRET は使えません（秘密の値は、ORIGIN_VERIFY_ARN の Secrets Manager から、実行時に読みます）',
    );
  }
  // ジョブは、EventBridge から起動する（Issue #76）。Lambda の中で、タイマーによるスケジューラを動かさない
  return { ...config, devApiEnabled: false, schedulerEnabled: false };
}

/** 取り込み・連携のスキーマ。data-dictionary.md 9.2・10.1、FR-1、FR-8。 */

import { z } from 'zod';
import {
  FEDERATION_RESULTS,
  FEDERATION_STATUSES,
  INGESTION_INTERVAL_MINUTES_OPTIONS,
  type FederationStatus,
} from '../constants/status.ts';
import { EquipmentIdSchema, IsoDateTimeSchema } from './common.ts';

export const INGESTION_SOURCE_KINDS = ['ROBOT', 'SENSOR'] as const;

/** 取得間隔（分）。候補は INGESTION_INTERVAL_MINUTES_OPTIONS（FR-1.5）。 */
export const IngestionIntervalSchema = z.union(
  INGESTION_INTERVAL_MINUTES_OPTIONS.map((minutes) => z.literal(minutes)),
);

export const FILE_SERVER_CONNECTION_TYPES = ['HTTP'] as const;
export const FILE_SERVER_PROTOCOLS = ['HTTPS', 'HTTP'] as const;
export const FILE_SERVER_AUTH_METHODS = ['NONE', 'BASIC', 'BEARER', 'API_KEY'] as const;
export type FileServerProtocol = (typeof FILE_SERVER_PROTOCOLS)[number];
export type FileServerAuthMethod = (typeof FILE_SERVER_AUTH_METHODS)[number];

/** API キーを送るヘッダー名の既定値（認証方式 API_KEY）。 */
export const DEFAULT_API_KEY_HEADER_NAME = 'X-API-Key';

/** API キーのヘッダー名にできない名前（認証・メッセージの区切り・接続の制御に関わるもの。小文字で比較する）。 */
const RESERVED_HEADER_NAMES = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'cookie',
  'set-cookie',
  'range',
  'accept-encoding',
]);

/** 既定のポート（HTTPS が 443、HTTP が 80）。 */
export function defaultHttpPort(protocol: FileServerProtocol): number {
  return protocol === 'HTTPS' ? 443 : 80;
}

const PORT_MESSAGE = 'ポート番号は、1〜65535 の数字で指定してください';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isIpv4Text(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 && parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** ホスト: ドメイン名（FQDN・短い名前）・IPv4・[IPv6]。スキーム・ポート・パス・認証情報は含められない。 */
function isValidHost(host: string): boolean {
  if (host.startsWith('[')) {
    return (
      host.endsWith(']') &&
      /^[0-9a-f:.]{2,45}$/.test(host.slice(1, -1)) &&
      host.split(':').length >= 3
    );
  }
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  const labels = host.split('.');
  if (!labels.every((label) => DNS_LABEL.test(label))) {
    return false;
  }
  // 数字だけの名前は、IPv4 として正しいものだけ（256.1.1.1・2130706433 などを避ける）
  return labels.every((label) => /^[0-9]+$/.test(label)) ? isIpv4Text(host) : true;
}

const HostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    isValidHost,
    '接続先のホスト名は、FQDN・IPv4・[IPv6] で指定してください（スキーム・ポート・パスは含めません）',
  );

const ApiKeyHeaderNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'ヘッダー名は、英数字・_・- の 64 文字以内で指定してください')
  .refine((name) => !RESERVED_HEADER_NAMES.has(name.toLowerCase()), 'このヘッダー名は使えません');

/**
 * ファイルサーバーの接続設定（Issue #172。ADR-0022）。認証情報の値（パスワード・トークン・API キー）は持たない。
 * 値は、秘密情報の保管先（SecretPort。Issue #206）に置く（NFR-5.4）。
 */
export const FileServerConnectionSchema = z.object({
  type: z.literal('HTTP'),
  protocol: z.enum(FILE_SERVER_PROTOCOLS).default('HTTPS'),
  host: HostSchema,
  /** 省略は、プロトコルの既定（HTTPS が 443、HTTP が 80）。 */
  port: z
    .number({ error: PORT_MESSAGE })
    .int(PORT_MESSAGE)
    .min(1, PORT_MESSAGE)
    .max(65535, PORT_MESSAGE)
    .optional(),
  authMethod: z.enum(FILE_SERVER_AUTH_METHODS).default('NONE'),
  /** 認証方式が API_KEY のときに、API キーを送るヘッダー名。 */
  apiKeyHeaderName: ApiKeyHeaderNameSchema.default(DEFAULT_API_KEY_HEADER_NAME),
});
export type FileServerConnection = z.infer<typeof FileServerConnectionSchema>;
/** 以前の名前（接続方式が MOCK と HTTP の 2 つだったとき。ADR-0025 の PR 3b で、MOCK を廃止し、HTTP だけになった）。 */
export type HttpFileServerConnection = FileServerConnection;

/** 接続先の表示用の URL（クエリ・認証情報を含まない）。接続が未設定なら undefined。 */
export function describeConnectionTarget(
  connection: FileServerConnection | undefined,
): string | undefined {
  if (connection === undefined) {
    return undefined;
  }
  const scheme = connection.protocol.toLowerCase();
  const port =
    connection.port === undefined || connection.port === defaultHttpPort(connection.protocol)
      ? ''
      : `:${String(connection.port)}`;
  return `${scheme}://${connection.host}${port}`;
}

/**
 * 取り込み元の設定（取り込み元ごとの有効／無効）。接続・認証情報は、設備ごと（Issue #367。ADR-0026）。
 * 以前に保存された取り込み元の接続（`connection`）・接続設定の参照名（`connectionRef`）は、読み込むときに無視する（共通の接続の廃止）。
 */
export const IngestionSourceSchema = z.object({
  sourceId: z.string().min(1).max(100),
  kind: z.enum(INGESTION_SOURCE_KINDS),
  /** 解釈に使う FormatProfile の識別子。 */
  profileId: z.string().min(1),
  /**
   * 取得間隔は、設備ごとの設定（Equipment.intervalMinutes。Issue #197）。以前に保存された取り込み元ごとの取得間隔は、
   * 読み込むときに無視する（移行しない）。
   */
  isEnabled: z.boolean(),
});
export type IngestionSource = z.infer<typeof IngestionSourceSchema>;

export const INGESTION_RESULTS = ['SUCCESS', 'PARTIAL', 'FAILURE'] as const;

/** 取り込みのハウスごとの結果（Issue #332）。ハウスに結びつけられた取り込みだけを持つ。 */
export const FacilityIngestionSchema = z.object({
  facilityId: z.string(),
  /** そのハウスのファイルに、取り込めなかったものがあれば FAILURE。 */
  result: z.enum(['SUCCESS', 'FAILURE']),
  recordCount: z.number().int().nonnegative(),
});
export type FacilityIngestion = z.infer<typeof FacilityIngestionSchema>;

export const IngestionLogSchema = z.object({
  logId: z.string(),
  sourceId: z.string(),
  /**
   * ログの設備（Issue #201。ADR-0016 の D-48）。新しいデータがあった設備・ファイルを取り込めなかった設備ごとに、1 件ずつ残す。
   * 設備に結びつかない結果（接続の失敗・どの設備にも結びつかない記録・以前のログ）は、持たない（取り込み元単位のログ）。
   */
  equipmentId: EquipmentIdSchema.optional(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  result: z.enum(INGESTION_RESULTS),
  filesProcessed: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  /**
   * 削除済みの設備のレコードの数（棄却数に含めない。Issue #231。ADR-0018 の D-28）。取り込み元単位のログにだけ、ある場合に持つ
   * （削除済みの設備のレコードだけの実行は、ログを残さない）。以前のログは、持たない。
   */
  deletedEquipmentCount: z.number().int().positive().optional(),
  attempts: z.number().int().positive(),
  formatProfileVersion: z.string().optional(),
  /** 失敗の内容。秘密情報・内部情報を含めない。 */
  errorMessage: z.string().optional(),
  /**
   * ハウスごとの結果。一般ユーザーに、閲覧できるハウスの分だけを見せるための内訳（Issue #332）。
   * ハウスに結びつけられない結果（接続の失敗・設備に結びつかないファイルの失敗）は、持たない。以前のログにも、ない。
   */
  facilities: z.array(FacilityIngestionSchema).optional(),
});
export type IngestionLog = z.infer<typeof IngestionLogSchema>;

/** 一般ユーザーに見せる、ハウスごとの取り込みの記録（1 回の取り込み × 1 ハウス）。接続先・失敗の理由・全体の件数は、含めない。 */
export const FacilityIngestionLogSchema = z.object({
  logId: z.string(),
  facilityId: z.string(),
  sourceId: z.string(),
  occurredAt: IsoDateTimeSchema,
  result: z.enum(['SUCCESS', 'FAILURE']),
  recordCount: z.number().int().nonnegative(),
});
export type FacilityIngestionLog = z.infer<typeof FacilityIngestionLogSchema>;

export const FacilityIngestionLogListResponseSchema = z.object({
  items: z.array(FacilityIngestionLogSchema),
  nextCursor: z.string().nullable(),
});
export type FacilityIngestionLogListResponse = z.infer<
  typeof FacilityIngestionLogListResponseSchema
>;

export const FederationItemSchema = z.object({
  federationItemId: z.string(),
  /** 観測値・評価結果・設備（名前・ID。Issue #177。ADR-0024）。以前の項目に、設備はない。 */
  targetType: z.enum(['OBSERVATION', 'EVALUATION', 'EQUIPMENT']),
  targetRef: z.string(),
  /** 送るデータのスナップショット（連携キュー。ADR-0004）。 */
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(FEDERATION_STATUSES),
  attempts: z.number().int().nonnegative(),
  result: z.string().optional(),
  enqueuedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** 次に送信を試みてよい日時（再試行の間隔を広げるため）。 */
  nextAttemptAt: IsoDateTimeSchema,
  /** 送るデータの設備が属するハウス（Issue #332。積むときに決める）。以前の項目には、ない。 */
  facilityIds: z.array(z.string()).optional(),
});
export type FederationItem = z.infer<typeof FederationItemSchema>;

/** 取り込み元の設定の変更（有効／無効。FR-1.4）。接続は設備ごと（Issue #367）、取得間隔も設備ごと（Issue #197）。 */
export const IngestionSourceUpdateSchema = z.object({
  sourceId: z.string().min(1).max(100),
  isEnabled: z.boolean(),
});
export type IngestionSourceUpdate = z.infer<typeof IngestionSourceUpdateSchema>;

export const IngestionSettingsUpdateRequestSchema = z.object({
  sources: z.array(IngestionSourceUpdateSchema).min(1),
});
export type IngestionSettingsUpdateRequest = z.infer<typeof IngestionSettingsUpdateRequestSchema>;

/** 制御文字（0x00〜0x1f・0x7f）を含むか。 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** トークン・API キーの値にできる文字（表示できる ASCII。空白・改行・日本語を含めない。ヘッダーの注入を避ける）。 */
const SECRET_TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const SECRET_TOKEN_MESSAGE = '英数字と記号だけで入力してください（空白・改行・日本語は使えません）';

function secretTokenSchema(requiredMessage: string) {
  return z
    .string()
    .trim()
    .min(1, requiredMessage)
    .max(2000, '2000文字以内で入力してください')
    .regex(SECRET_TOKEN_PATTERN, SECRET_TOKEN_MESSAGE);
}

/**
 * ファイルサーバーの認証情報の登録（Issue #207。D-47）。書き込み専用で、保存後は、値を再表示しない。
 * 認証方式は、保存済みの接続設定と同じでなければならない。値は、SecretPort（file-server/equipment/<設備 ID のハッシュ>）に保存する。
 */
export const IngestionCredentialsInputSchema = z.discriminatedUnion('authMethod', [
  z.object({
    authMethod: z.literal('BASIC'),
    username: z
      .string()
      .min(1, 'ユーザー名を入力してください')
      .max(200, 'ユーザー名は200文字以内で入力してください')
      .refine((value) => !value.includes(':'), 'ユーザー名に : は使えません')
      .refine((value) => !hasControlCharacter(value), 'ユーザー名に制御文字は使えません'),
    password: z
      .string()
      .min(1, 'パスワードを入力してください')
      .max(1000, 'パスワードは1000文字以内で入力してください'),
  }),
  z.object({
    authMethod: z.literal('BEARER'),
    token: secretTokenSchema('トークンを入力してください'),
  }),
  z.object({
    authMethod: z.literal('API_KEY'),
    apiKey: secretTokenSchema('API キーを入力してください'),
  }),
]);
export type IngestionCredentialsInput = z.infer<typeof IngestionCredentialsInputSchema>;

/**
 * 認証情報の状態。値は含めない。NOT_REQUIRED = 認証が不要（モック・認証なし）、NOT_CONFIGURED = 未設定、
 * CONFIGURED = 設定済み（更新日時を持つ）、UNAVAILABLE = 保管先から状態を読み出せない。
 */
export const IngestionCredentialStatusSchema = z.object({
  state: z.enum(['NOT_REQUIRED', 'NOT_CONFIGURED', 'CONFIGURED', 'UNAVAILABLE']),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type IngestionCredentialStatus = z.infer<typeof IngestionCredentialStatusSchema>;

/** 設備ごとの、取り込みの最終の実行（Issue #201）。一度も実行していない設備は、日時・結果が null。 */
export const EquipmentIngestionStatusSchema = z.object({
  equipmentId: EquipmentIdSchema,
  name: z.string(),
  /** 設備のファイルのパス（Equipment.sourceFilePath）。取り込みの対象は、ファイルのパスを持つ設備だけ。 */
  sourceFilePath: z.string().optional(),
  /** 設備の接続（Issue #367。ADR-0026）。未設定なら、省略（取り込みは「接続先が設定されていません」で失敗する）。 */
  connection: FileServerConnectionSchema.optional(),
  /**
   * 「データが古い（取り込みが停止中）」の基準（分）。その設備の取得間隔 × 倍数（サーバーの設定 `STALE_AFTER_INTERVALS`）、最低 3 分
   * （ダッシュボードと同じ基準。ADR-0016 の D-12）。画面は、最後にデータが取れた日時から、この分数を超えていれば「停止中」にする。
   */
  staleThresholdMinutes: z.number().positive().optional(),
  /** 設備の認証情報の状態（接続が未設定、または、認証方式が「なし」なら、不要）。値は含めない。 */
  credentials: IngestionCredentialStatusSchema.default({ state: 'NOT_REQUIRED' }),
  lastStartedAt: IsoDateTimeSchema.nullable(),
  lastResult: z.enum(INGESTION_RESULTS).nullable(),
  /** 最後に成功（SUCCESS）した実行の終了日時。 */
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  /** 最後に新しいデータ（1 件以上の記録）を取り込んだ実行の終了日時。 */
  lastDataAt: IsoDateTimeSchema.nullable(),
});
export type EquipmentIngestionStatus = z.infer<typeof EquipmentIngestionStatusSchema>;

/** 取り込み元の設定と状況（解釈に使う仕様の版・状態、最終の取得）。認証情報の値は含めない。 */
export const IngestionSourceStatusSchema = IngestionSourceSchema.extend({
  formatProfile: z.object({
    versionLabel: z.string(),
    status: z.enum(['PROVISIONAL', 'CONFIRMED']),
  }),
  lastStartedAt: IsoDateTimeSchema.nullable(),
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  /** その取り込み元の種別の設備ごとの、最終の実行（設備の一覧の順。Issue #201）。 */
  equipment: z.array(EquipmentIngestionStatusSchema).default([]),
  isRunning: z.boolean(),
});
export type IngestionSourceStatus = z.infer<typeof IngestionSourceStatusSchema>;

export const IngestionSettingsResponseSchema = z.object({
  sources: z.array(IngestionSourceStatusSchema),
});
export type IngestionSettingsResponse = z.infer<typeof IngestionSettingsResponseSchema>;

/** PUT /ingestion/equipment/{equipmentId}/connection の入力（設備ごとの接続の保存。Issue #367）。 */
export const EquipmentConnectionUpdateSchema = z.object({
  connection: FileServerConnectionSchema,
});
export type EquipmentConnectionUpdate = z.infer<typeof EquipmentConnectionUpdateSchema>;

/** 設備ごとの接続の、保存・削除の応答。削除のあとは、接続は省略（未設定）。 */
export const EquipmentConnectionResponseSchema = z.object({
  equipmentId: EquipmentIdSchema,
  connection: FileServerConnectionSchema.optional(),
  credentials: IngestionCredentialStatusSchema,
});
export type EquipmentConnectionResponse = z.infer<typeof EquipmentConnectionResponseSchema>;

export const ConnectionTestResponseSchema = z.object({ ok: z.boolean(), message: z.string() });
export type ConnectionTestResponse = z.infer<typeof ConnectionTestResponseSchema>;

/**
 * 画面から置く、取り込み用のファイルの大きさの上限（バイト。1 MiB）。API の本文の上限と同じ（本文は、ファイルそのもの。JSON の包みは付けない）。
 * 自前のファイルサーバーの `PUT` の上限（`HOSTED_FILE_MAX_BYTES`）とも同じ（ADR-0027）。
 */
export const SOURCE_FILE_MAX_BYTES = 1024 * 1024;

/**
 * 置く前の検査の結果（`POST /ingestion/equipment/{id}/source-file/check`。Issue #565）。取り込みと同じ解釈（FormatProfile・項目の検証）を、保存せずに行う。
 * `problems`（置けない理由）が空でなければ、`ok` は false。`warnings`（置けるが、取り込みで「不正」などになる点）は、項目名だけで、値を含めない。
 */
export const SourceFileInspectionSchema = z.object({
  ok: z.boolean(),
  /** 解釈に使う仕様の版の表記（例: `robot-json@1.0.0(CONFIRMED)`）。 */
  formatLabel: z.string(),
  /** ファイルの大きさ（バイト）。 */
  size: z.number().int().nonnegative(),
  /** 読み取れた計測日時。読み取れなければ省略。 */
  observedAt: IsoDateTimeSchema.optional(),
  /** 読み取れた項目の数（取り込みの対象の項目）。 */
  itemCount: z.number().int().nonnegative(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SourceFileInspection = z.infer<typeof SourceFileInspectionSchema>;

/** ファイルを置いた結果（`PUT /ingestion/equipment/{id}/source-file`）。検査の結果と、置いた日時。 */
export const SourceFilePlacedSchema = SourceFileInspectionSchema.extend({
  placedAt: IsoDateTimeSchema,
});
export type SourceFilePlaced = z.infer<typeof SourceFilePlacedSchema>;

export const IngestionRunResponseSchema = z.object({
  sourceId: z.string(),
  result: z.enum(INGESTION_RESULTS),
  filesProcessed: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  /** 削除済みの設備のレコードの数（棄却数に含めない。Issue #231）。 */
  deletedEquipmentCount: z.number().int().nonnegative().default(0),
  attempts: z.number().int().positive(),
});
export type IngestionRunResponse = z.infer<typeof IngestionRunResponseSchema>;

export const IngestionLogListResponseSchema = z.object({
  items: z.array(IngestionLogSchema),
  nextCursor: z.string().nullable(),
});
export type IngestionLogListResponse = z.infer<typeof IngestionLogListResponseSchema>;

export const FederationLogSchema = z.object({
  logId: z.string(),
  occurredAt: IsoDateTimeSchema,
  /** 成功（SENT）／失敗（FAILED）／保留（HELD）／期限切れ（EXPIRED。破棄の期限を過ぎて破棄した）。FR-8.3。 */
  result: z.enum(FEDERATION_RESULTS),
  itemCount: z.number().int().nonnegative(),
  message: z.string().optional(),
  /** ハウスごとの項目数（Issue #332。一般ユーザーに、閲覧できるハウスの分だけを見せるための内訳）。以前のログには、ない。 */
  facilities: z
    .array(z.object({ facilityId: z.string(), itemCount: z.number().int().nonnegative() }))
    .optional(),
});
export type FederationLog = z.infer<typeof FederationLogSchema>;

/** 一般ユーザーに見せる、ハウスごとの連携の記録（1 回の連携 × 1 ハウス）。失敗の理由・キューの件数は、含めない。 */
export const FacilityFederationLogSchema = z.object({
  logId: z.string(),
  facilityId: z.string(),
  occurredAt: IsoDateTimeSchema,
  result: z.enum(FEDERATION_RESULTS),
  itemCount: z.number().int().nonnegative(),
});
export type FacilityFederationLog = z.infer<typeof FacilityFederationLogSchema>;

export const FacilityFederationLogListResponseSchema = z.object({
  items: z.array(FacilityFederationLogSchema),
  nextCursor: z.string().nullable(),
});
export type FacilityFederationLogListResponse = z.infer<
  typeof FacilityFederationLogListResponseSchema
>;

const QueueCountSchema = z.number().int().nonnegative();

/** 連携の状況: 結果の記録（新しい順）と、連携キューの状態ごとの件数。 */
export const FederationLogListResponseSchema = z.object({
  items: z.array(FederationLogSchema),
  nextCursor: z.string().nullable(),
  queue: z.object({
    PENDING: QueueCountSchema,
    SENT: QueueCountSchema,
    FAILED: QueueCountSchema,
    HELD: QueueCountSchema,
    EXPIRED: QueueCountSchema,
  } satisfies Record<FederationStatus, typeof QueueCountSchema>),
});
export type FederationLogListResponse = z.infer<typeof FederationLogListResponseSchema>;

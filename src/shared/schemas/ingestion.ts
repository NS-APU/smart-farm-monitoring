/** 取り込み・連携のスキーマ。data-dictionary.md 9.2・10.1、FR-1、FR-8。 */

import { z } from 'zod';
import {
  FEDERATION_RESULTS,
  FEDERATION_STATUSES,
  INGESTION_INTERVAL_MINUTES_OPTIONS,
  type FederationStatus,
} from '../constants/status.ts';
import { IsoDateTimeSchema } from './common.ts';

export const INGESTION_SOURCE_KINDS = ['ROBOT', 'SENSOR'] as const;

/** 取得間隔（分）。候補は INGESTION_INTERVAL_MINUTES_OPTIONS（FR-1.5）。 */
export const IngestionIntervalSchema = z.union(
  INGESTION_INTERVAL_MINUTES_OPTIONS.map((minutes) => z.literal(minutes)),
);

export const FILE_SERVER_CONNECTION_TYPES = ['MOCK', 'HTTP'] as const;
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

/** ファイルパス: / で始まるファイル 1 つ。クエリ・フラグメント・空白・.. ・% のエスケープは使えない。 */
const FilePathSchema = z
  .string()
  .min(2, 'ファイルパスを入力してください')
  .max(500, 'ファイルパスは500文字以内で指定してください')
  .refine(
    (path) =>
      /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(path) &&
      !path.endsWith('/') &&
      path
        .split('/')
        .every(
          (segment, index) =>
            index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
        ),
    'ファイルパスは、/ で始まるファイル 1 つを、英数字と記号（. _ ~ - / など）で指定してください（..・?・#・空白・% は使えません）',
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
export const FileServerConnectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MOCK') }),
  z.object({
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
    filePath: FilePathSchema,
    authMethod: z.enum(FILE_SERVER_AUTH_METHODS).default('NONE'),
    /** 認証方式が API_KEY のときに、API キーを送るヘッダー名。 */
    apiKeyHeaderName: ApiKeyHeaderNameSchema.default(DEFAULT_API_KEY_HEADER_NAME),
  }),
]);
export type FileServerConnection = z.infer<typeof FileServerConnectionSchema>;
export type HttpFileServerConnection = Extract<FileServerConnection, { type: 'HTTP' }>;

/** 接続先の表示用の URL（クエリ・認証情報を含まない）。接続を持たない（MOCK）は undefined。 */
export function describeConnectionTarget(connection: FileServerConnection): string | undefined {
  if (connection.type !== 'HTTP') {
    return undefined;
  }
  const scheme = connection.protocol.toLowerCase();
  const port =
    connection.port === undefined || connection.port === defaultHttpPort(connection.protocol)
      ? ''
      : `:${String(connection.port)}`;
  return `${scheme}://${connection.host}${port}${connection.filePath}`;
}

/**
 * 取り込み元の設定。認証情報の値は持たず、接続設定の参照名（connectionRef）のみ持つ（NFR-5.4）。
 */
export const IngestionSourceSchema = z.object({
  sourceId: z.string().min(1).max(100),
  kind: z.enum(INGESTION_SOURCE_KINDS),
  /** 解釈に使う FormatProfile の識別子。 */
  profileId: z.string().min(1),
  connectionRef: z.string().min(1),
  /** ファイルサーバーの接続設定。保存がない既存の設定は、MOCK（移行不要）。 */
  connection: FileServerConnectionSchema.default({ type: 'MOCK' }),
  intervalMinutes: IngestionIntervalSchema,
  isEnabled: z.boolean(),
});
export type IngestionSource = z.infer<typeof IngestionSourceSchema>;

export const INGESTION_RESULTS = ['SUCCESS', 'PARTIAL', 'FAILURE'] as const;

export const IngestionLogSchema = z.object({
  logId: z.string(),
  sourceId: z.string(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  result: z.enum(INGESTION_RESULTS),
  filesProcessed: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  formatProfileVersion: z.string().optional(),
  /** 失敗の内容。秘密情報・内部情報を含めない。 */
  errorMessage: z.string().optional(),
});
export type IngestionLog = z.infer<typeof IngestionLogSchema>;

export const FederationItemSchema = z.object({
  federationItemId: z.string(),
  targetType: z.enum(['OBSERVATION', 'EVALUATION']),
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
});
export type FederationItem = z.infer<typeof FederationItemSchema>;

/** 取り込み元の設定の変更（接続先の参照名・取得間隔・有効／無効。FR-1.4、1.5）。 */
export const IngestionSourceUpdateSchema = z.object({
  sourceId: z.string().min(1).max(100),
  connectionRef: z
    .string()
    .trim()
    .min(1, '接続先の参照名を入力してください')
    .max(100, '接続先の参照名は100文字以内で指定してください')
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, '接続先の参照名は英数字・記号（_ . -）のみ使えます'),
  /** 省略は、現在の接続設定を保つ。 */
  connection: FileServerConnectionSchema.optional(),
  intervalMinutes: IngestionSourceSchema.shape.intervalMinutes,
  isEnabled: z.boolean(),
});
export type IngestionSourceUpdate = z.infer<typeof IngestionSourceUpdateSchema>;

export const IngestionSettingsUpdateRequestSchema = z.object({
  sources: z.array(IngestionSourceUpdateSchema).min(1),
});
export type IngestionSettingsUpdateRequest = z.infer<typeof IngestionSettingsUpdateRequestSchema>;

/** 取り込み元の設定と状況（解釈に使う仕様の版・状態、最終の取得）。認証情報の値は含めない。 */
export const IngestionSourceStatusSchema = IngestionSourceSchema.extend({
  formatProfile: z.object({
    versionLabel: z.string(),
    status: z.enum(['PROVISIONAL', 'CONFIRMED']),
  }),
  lastStartedAt: IsoDateTimeSchema.nullable(),
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  isRunning: z.boolean(),
});
export type IngestionSourceStatus = z.infer<typeof IngestionSourceStatusSchema>;

export const IngestionSettingsResponseSchema = z.object({
  sources: z.array(IngestionSourceStatusSchema),
});
export type IngestionSettingsResponse = z.infer<typeof IngestionSettingsResponseSchema>;

export const ConnectionTestResponseSchema = z.object({ ok: z.boolean(), message: z.string() });
export type ConnectionTestResponse = z.infer<typeof ConnectionTestResponseSchema>;

export const IngestionRunResponseSchema = z.object({
  sourceId: z.string(),
  result: z.enum(INGESTION_RESULTS),
  filesProcessed: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
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
});
export type FederationLog = z.infer<typeof FederationLogSchema>;

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

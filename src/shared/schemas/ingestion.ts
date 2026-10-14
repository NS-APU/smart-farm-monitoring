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

/**
 * 取り込み元の設定。認証情報の値は持たず、接続設定の参照名（connectionRef）のみ持つ（NFR-5.4）。
 */
export const IngestionSourceSchema = z.object({
  sourceId: z.string().min(1).max(100),
  kind: z.enum(INGESTION_SOURCE_KINDS),
  /** 解釈に使う FormatProfile の識別子。 */
  profileId: z.string().min(1),
  connectionRef: z.string().min(1),
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
  /** 成功（SENT）／失敗（FAILED）／保留（HELD）。FR-8.3。 */
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
  } satisfies Record<FederationStatus, typeof QueueCountSchema>),
});
export type FederationLogListResponse = z.infer<typeof FederationLogListResponseSchema>;

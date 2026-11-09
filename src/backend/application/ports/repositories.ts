/**
 * Repository のポート（ADR-0001）。ドメイン・アプリケーションのコードに DB の型を出さない。
 * 実装: infrastructure/local（インメモリ＋ファイル永続化）。DynamoDB の実装は後で追加する
 * （物理設計は data-model.md 2章。同じ契約テストを適用する）。
 */

import type { Category } from '@smart-farm/shared/constants/items';
import type {
  ManualEntrySortKey,
  ObservationSortKey,
  SortDirection,
} from '@smart-farm/shared/constants/sorting';
import type {
  NotificationKind,
  ObservationSource,
  PeriodDays,
  ReadState,
  Horizon,
} from '@smart-farm/shared/constants/status';
import type { ViewpointId } from '@smart-farm/shared/constants/viewpoints';
import type { AuditLogEntry } from '@smart-farm/shared/schemas/audit';
import type { EquipmentId, NotificationId, UserId } from '@smart-farm/shared/schemas/common';
import type { ViewpointCriteria } from '@smart-farm/shared/schemas/criteria';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type { ManualEntry } from '@smart-farm/shared/schemas/manual-entry';
import type { EvaluationResult } from '@smart-farm/shared/schemas/evaluation';
import type {
  FederationItem,
  FederationLog,
  IngestionLog,
} from '@smart-farm/shared/schemas/ingestion';
import type { Notification, NotificationMemo } from '@smart-farm/shared/schemas/notification';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import type {
  IngestedFileRecord,
  PushSubscriptionRecord,
  StatusChangeEntry,
  UserRecord,
} from './records.ts';

export interface PageRequest {
  readonly limit: number;
  /** 前回の応答の nextCursor。不透明な文字列として扱う。 */
  readonly cursor?: string | undefined;
}

export interface Page<Item> {
  readonly items: Item[];
  readonly nextCursor: string | null;
}

export interface EquipmentRepository {
  list(options?: { readonly includeDeleted?: boolean }): Promise<Equipment[]>;
  get(equipmentId: EquipmentId): Promise<Equipment | undefined>;
  save(equipment: Equipment): Promise<void>;
}

export interface StatusCodeRepository {
  list(options?: { readonly includeDeleted?: boolean }): Promise<StatusCodeDefinition[]>;
  get(code: string): Promise<StatusCodeDefinition | undefined>;
  save(definition: StatusCodeDefinition): Promise<void>;
}

/** 判断基準の変更後の値（既定値はコードで持つため、変更がない観点は持たない）。 */
export interface CriteriaRepository {
  get(viewpointId: ViewpointId): Promise<ViewpointCriteria | undefined>;
  save(criteria: ViewpointCriteria): Promise<void>;
  delete(viewpointId: ViewpointId): Promise<void>;
}

export interface ObservationFilter {
  readonly equipmentIds?: readonly EquipmentId[];
  readonly category?: Category;
  readonly itemKey?: string;
  /** 項目の絞り込み（いずれかに一致）。itemKey と同時に指定した場合は、両方に一致するもの。 */
  readonly itemKeys?: readonly string[];
  readonly source?: ObservationSource;
  readonly from?: Date;
  readonly to?: Date;
  readonly includeDeleted?: boolean;
  /**
   * アプリ側の追加の絞り込み（キーワード検索など、表示名を使う条件）。
   * DynamoDB の実装は、キーの条件で取得した結果に適用する。
   */
  readonly matches?: (observation: Observation) => boolean;
}

export interface ObservationRepository {
  /** 一意キー（設備・項目・計測日時・取得元）で、追加または上書きする。 */
  saveMany(observations: readonly Observation[]): Promise<void>;
  /** 評価の入力: 指定した設備・期間の、論理削除でない観測値。 */
  findForEvaluation(
    equipmentIds: readonly EquipmentId[],
    from: Date,
    to: Date,
  ): Promise<Observation[]>;
  query(
    filter: ObservationFilter,
    page: PageRequest,
    sort?: { readonly key: ObservationSortKey; readonly direction: SortDirection },
  ): Promise<Page<Observation>>;
  /** 一意キー（設備・項目・計測日時の文字列・取得元）の観測値を、直接引く（論理削除済みも含む）。なければ undefined。 */
  findByKey(
    equipmentId: EquipmentId,
    itemKey: string,
    observedAt: string,
    source: Observation['source'],
  ): Promise<Observation | undefined>;
  /** 最終のデータ取得日時（受信日時の最大。設備を指定した場合はその設備のみ）。1件もなければ null。 */
  latestReceivedAt(
    equipmentIds?: readonly EquipmentId[],
    options?: { readonly autoImportOnly?: boolean },
  ): Promise<Date | null>;
}

export interface EvaluationRepository {
  /** 観点・設備・視点・期間ごとの最新の評価結果を、上書き保存する。 */
  saveLatest(result: EvaluationResult): Promise<void>;
  getLatest(
    equipmentId: EquipmentId,
    viewpointId: ViewpointId,
    horizon: Horizon,
    periodDays: PeriodDays | null,
  ): Promise<EvaluationResult | undefined>;
  /** 設備の、すべての観点・視点・期間の最新の評価結果。 */
  listLatest(equipmentId: EquipmentId): Promise<EvaluationResult[]>;
  appendStatusChange(entry: StatusChangeEntry): Promise<void>;
  getLastStatusChange(
    equipmentId: EquipmentId,
    viewpointId: ViewpointId,
  ): Promise<StatusChangeEntry | undefined>;
  /** 観点の最終ステータスの変化の履歴（古い順。ステータスの推移。FR-6.10）。 */
  listStatusChanges(
    equipmentId: EquipmentId,
    viewpointId: ViewpointId,
  ): Promise<StatusChangeEntry[]>;
}

export interface NotificationListFilter {
  readonly kind?: NotificationKind;
  readonly readState?: ReadState;
  /** この日時以前（ちょうどを含む）に作成された通知だけ。一括既読が、画面を読み込んだあとに届いた通知を、既読にしないための上限（#240）。 */
  readonly until?: Date;
}

export interface NotificationWithReadState {
  readonly notification: Notification;
  readonly isRead: boolean;
}

/** 状態変化の通知の、設備・観点・作成日時（通知の経過を導出するとき、同じ設備・観点の「次の通知」を探すために使う。Issue #238）。 */
export interface StatusChangeNotificationTime {
  readonly equipmentId: EquipmentId;
  readonly viewpointId: ViewpointId;
  readonly createdAt: string;
}

export interface NotificationRepository {
  add(notification: Notification): Promise<void>;
  get(notificationId: NotificationId): Promise<Notification | undefined>;
  findLatestByDedupKey(dedupKey: string): Promise<Notification | undefined>;
  /** 新しい順。既読状態は利用者ごと（暫定）。 */
  list(
    userId: UserId,
    filter: NotificationListFilter,
    page: PageRequest,
  ): Promise<Page<NotificationWithReadState>>;
  unreadCount(userId: UserId): Promise<number>;
  /** 既読にする。通知がなければ false。 */
  markRead(notificationId: NotificationId, userId: UserId, readAt: Date): Promise<boolean>;
  /** 絞り込みの範囲（`until` 以前を含む）の未読の件数。一括既読の確認の件数で、`markAllRead` が既読にする件数と一致する。 */
  countUnread(userId: UserId, filter: NotificationListFilter): Promise<number>;
  /** 絞り込みの範囲（`until` 以前を含む）の未読を、すべて既読にする。新しく既読にした件数を返す。 */
  markAllRead(userId: UserId, filter: NotificationListFilter, readAt: Date): Promise<number>;
  update(notification: Notification): Promise<void>;
  /** メモを追記する（追記のみ。編集・削除はない。ADR-0019 の D-42。#239）。通知の存在は、呼び出し側が確かめる。 */
  addMemo(memo: NotificationMemo): Promise<void>;
  /** 通知のメモ。入力の古い順（同じ日時は、メモの識別子の順）。なければ空。 */
  listMemos(notificationId: NotificationId): Promise<NotificationMemo[]>;
  /** 通知ごとのメモの件数（通知の識別子 → 件数）。メモがなければ 0。 */
  memoCounts(notificationIds: readonly NotificationId[]): Promise<Map<NotificationId, number>>;
  /**
   * Web Push の配信が必要な通知（まとめの状態が未完了〔PENDING〕のもの。購読ごとの状態を持たない以前の形式の失敗も、購読ごとの形式で終了させるため、含む）。
   * 再送の上限・期限は、呼び出し側（通知サービス）が、購読ごとの状態で判断する（ADR-0019 の D-38）。
   */
  listUndelivered(): Promise<Notification[]>;
  /**
   * 指定した日時より新しい（その日時ちょうどは含めない）、状態変化の通知（STATUS_CHANGE）の、設備・観点・作成日時。古い順。
   * 通知の経過・回復日時の導出（ADR-0019 の D-42）で、同じ設備・観点の次の通知を探すために使う。
   */
  listStatusChangeTimes(since: Date): Promise<StatusChangeNotificationTime[]>;
}

export interface IngestionRepository {
  /** 同じファイル（識別子とハッシュが同じ、または内容のハッシュが同じ）の取り込み済みの記録。 */
  findIngestedFile(
    sourceId: string,
    fileId: string,
    contentHash: string,
  ): Promise<IngestedFileRecord | undefined>;
  recordFile(record: IngestedFileRecord): Promise<void>;
  addLog(log: IngestionLog): Promise<void>;
  listLogs(filter: { readonly sourceId?: string }, page: PageRequest): Promise<Page<IngestionLog>>;
  /** 取り込み元の直近の開始日時（取得間隔の判定に使う）。 */
  lastStartedAt(sourceId: string): Promise<Date | null>;
  /** 取り込み元の直近の成功（結果が SUCCESS）の終了日時。成功がなければ null。 */
  lastSucceededAt(sourceId: string): Promise<Date | null>;
  /** 取り込み元が、新しいデータ（1件以上の記録）を取り込んだ直近の終了日時。一度もなければ null（データ取得の停止の判定に使う）。 */
  lastDataIngestedAt(sourceId: string): Promise<Date | null>;
}

export interface FederationRepository {
  enqueue(item: FederationItem): Promise<void>;
  /** 送信してよい項目（待機・失敗・保留で、次の試行の日時が来ているもの）。次の試行の日時の順（同じ日時は、積んだ順）。 */
  listDue(now: Date, limit: number): Promise<FederationItem[]>;
  /** 次の試行の日時が先の、保留・失敗の項目を、次の試行の日時の順（同じ日時は、積んだ順）に返す（送信に成功した後に、すぐ送る対象。ADR-0016 の D-06）。 */
  listWaiting(now: Date, limit: number): Promise<FederationItem[]>;
  update(item: FederationItem): Promise<void>;
  addLog(entry: FederationLog): Promise<void>;
  listLogs(page: PageRequest): Promise<Page<FederationLog>>;
  countByStatus(): Promise<Record<FederationItem['status'], number>>;
}

export interface AuditLogRepository {
  add(entry: AuditLogEntry): Promise<void>;
  /** 日時の新しい順（direction: asc で古い順）。 */
  list(
    filter: {
      readonly operation?: AuditLogEntry['operation'];
      readonly actor?: UserId;
      readonly targetType?: string;
      readonly from?: Date;
      readonly to?: Date;
      readonly direction?: SortDirection;
    },
    page: PageRequest,
  ): Promise<Page<AuditLogEntry>>;
}

export interface ManualEntryFilter {
  readonly category?: Category;
  readonly equipmentId?: EquipmentId;
  readonly from?: Date;
  readonly to?: Date;
  /** アプリ側の追加の絞り込み（キーワード検索など、表示名を使う条件）。 */
  readonly matches?: (entry: ManualEntry) => boolean;
}

/** 手動入力（1回の入力）。論理削除したものは、一覧に含めない。 */
export interface ManualEntryRepository {
  get(entryId: string): Promise<ManualEntry | undefined>;
  save(entry: ManualEntry): Promise<void>;
  list(
    filter: ManualEntryFilter,
    page: PageRequest,
    sort?: { readonly key: ManualEntrySortKey; readonly direction: SortDirection },
  ): Promise<Page<ManualEntry>>;
}

export interface UserRepository {
  get(userId: UserId): Promise<UserRecord | undefined>;
  list(): Promise<UserRecord[]>;
  save(user: UserRecord): Promise<void>;
  delete(userId: UserId): Promise<void>;
}

export interface PushSubscriptionRepository {
  /** 同じ識別子（利用者・端末ごと）は上書きする。 */
  save(subscription: PushSubscriptionRecord): Promise<void>;
  listActive(): Promise<PushSubscriptionRecord[]>;
  listByUser(userId: UserId): Promise<PushSubscriptionRecord[]>;
  delete(subscriptionId: string): Promise<void>;
  deactivate(subscriptionId: string): Promise<void>;
  deleteByUser(userId: UserId): Promise<void>;
}

/** 設定（取り込み設定など）。値は呼び出し側がスキーマで検証する。 */
export interface SettingsRepository {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** すべての Repository。アダプタ（ローカル・DynamoDB）ごとに1つ作る。 */
export interface Repositories {
  readonly equipment: EquipmentRepository;
  readonly statusCodes: StatusCodeRepository;
  readonly criteria: CriteriaRepository;
  readonly observations: ObservationRepository;
  readonly evaluations: EvaluationRepository;
  readonly notifications: NotificationRepository;
  readonly ingestion: IngestionRepository;
  readonly federation: FederationRepository;
  readonly auditLogs: AuditLogRepository;
  readonly manualEntries: ManualEntryRepository;
  readonly users: UserRepository;
  readonly pushSubscriptions: PushSubscriptionRepository;
  readonly settings: SettingsRepository;
}

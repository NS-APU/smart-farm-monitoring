/**
 * 取り込みのユースケース（UC-08, UC-09, UC-15, UC-24。JB-01。FR-1、data-flow.md 3章）。
 * 取得（FileSourcePort）→ 取り込み済みの判定 → 解釈（FormatProfile）→ 検証 → 保存 → ログ → 評価の更新。
 * 取り込み元ごとに独立して実行・再試行し、1つの失敗が他の取り込み元・他の機能を止めない（FR-1.9）。
 * 再試行しても取得できない場合は、取り込み失敗の通知を作る（UC-24）。
 */

import { createHash } from 'node:crypto';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import { MIN_STALE_THRESHOLD_MINUTES } from '@smart-farm/shared/constants/status';
import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import {
  effectiveIntervalMinutes,
  staleThresholdMinutesOf,
  type Equipment,
} from '@smart-farm/shared/schemas/equipment';
import type {
  FacilityIngestion,
  IngestionLog,
  IngestionRunResponse,
  IngestionSource,
} from '@smart-farm/shared/schemas/ingestion';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';
import { MS_PER_MINUTE } from '@smart-farm/shared/time';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import {
  classifyValue,
  isRejectedQuality,
  isUsableQuality,
} from '../../domain/observation-quality.ts';
import type { EvaluationService } from '../evaluation/evaluation-service.ts';
import type { FederationService } from '../federation/federation-service.ts';
import type { NotificationService } from '../notification/notification-service.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import {
  FileSourceFailure,
  FileSourceUnavailableError,
  type FileMeta,
  type FileSourcePort,
} from '../ports/file-source-port.ts';
import {
  FormatError,
  type FormatProfile,
  type FormatProfileRegistry,
} from '../ports/format-profile.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { Repositories } from '../ports/repositories.ts';
import { errorLogFields } from '../error-fields.ts';
import type { AppSettings } from '../settings.ts';
import { OperationTimeoutError, withTimeout } from '../with-timeout.ts';
import { listDeletedExternalIds } from '../equipment/deleted-external-ids.ts';
import { isAutoIngestionTarget } from './auto-target.ts';
import { sourceDisplayName, type IngestionSettings } from './ingestion-settings.ts';

/** 通知に載せる設備の名前の数（それを超えた分は、「ほか N 件」）。 */
const STOPPED_NAMES_SHOWN = 3;

/** 止まった設備の名前（先頭の 3 つ。残りは「ほか N 件」）。 */
function stoppedEquipmentNames(stopped: readonly Equipment[]): string {
  const shown = stopped.slice(0, STOPPED_NAMES_SHOWN).map((item) => `「${item.name}」`);
  const rest = stopped.length - shown.length;
  return rest > 0 ? `${shown.join('')}ほか ${String(rest)} 件` : shown.join('');
}

/** 設備ごとの、1 回の実行の集計（ログ・最終の実行の結果を決める）。 */
interface Tally {
  filesProcessed: number;
  recordCount: number;
  rejectedCount: number;
  failedFiles: number;
}

const emptyTally = (): Tally => ({
  filesProcessed: 0,
  recordCount: 0,
  rejectedCount: 0,
  failedFiles: 0,
});

/** 取り込みの実行結果。API の応答（IngestionRunResponse）と同じ形。 */
export type IngestionRunSummary = IngestionRunResponse;

export interface ConnectionTestResult {
  readonly ok: boolean;
  /** 利用者に見せるメッセージ。内部情報・認証情報を含めない（NFR-5.6）。 */
  readonly message: string;
}

export interface IngestionService {
  /** 取り込み元を1つ実行する。実行中の場合は CONFLICT（二重実行の防止）。 */
  runSource(sourceId: string): Promise<IngestionRunSummary>;
  /** 取得間隔が来ている取り込み元を実行する（スケジューラ。JB-01）。 */
  runDueSources(): Promise<IngestionRunSummary[]>;
  testConnection(sourceId: string): Promise<ConnectionTestResult>;
  /** 取り込み元が実行中か（二重実行の防止。画面で、実行中を示す）。 */
  isRunning(sourceId: string): boolean;
}

export interface IngestionServiceDeps {
  readonly repositories: Pick<
    Repositories,
    'equipment' | 'observations' | 'statusCodes' | 'ingestion' | 'settings'
  >;
  readonly ingestionSettings: IngestionSettings;
  readonly fileSource: FileSourcePort;
  readonly profiles: FormatProfileRegistry;
  readonly evaluation: EvaluationService;
  readonly notifications: NotificationService;
  readonly federation: FederationService;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly settings: AppSettings['ingestion'];
  readonly logger: Logger;
}

/** ファイル一覧の取得結果（再試行の回数つき）。 */
type Listing =
  | { readonly ok: true; readonly files: readonly FileMeta[]; readonly attempts: number }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number };

/** ファイルを取り込めなかった理由（通知・ログの文言を決める）。利用者に見せるため、内部情報を含めない。 */
const FAILURE_REASONS = {
  READ: 'ファイルを読めませんでした',
  FORMAT: '形式が仕様と異なるため、取り込めませんでした',
  TOO_LARGE: 'ファイルが大きすぎるため、読み込めませんでした',
  UNEXPECTED: 'ファイルの取り込み中にエラーが発生しました',
} as const;
type FailureKind = keyof typeof FAILURE_REASONS;

interface FileOutcome {
  /** 取り込んだファイルの識別子（設備ごとのログの帰属に使う）。 */
  readonly fileId: string;
  readonly recordCount: number;
  readonly rejectedCount: number;
  readonly failed: boolean;
  /** 失敗した場合の理由（failed が true のとき）。 */
  readonly failureKind?: FailureKind;
  /** 観測値を保存した設備（評価し直す設備）。 */
  readonly equipmentIds: readonly EquipmentId[];
  /** 設備ごとの、保存した記録の数（評価に使える記録）。1 つのファイルに複数の設備が入る場合の、設備ごとのログに使う。 */
  readonly savedByEquipment: ReadonlyMap<EquipmentId, number>;
  /**
   * 設備ごとの、取り込めなかった記録の数（設備の項目で、定義にない項目・不正な値。不正な値は、新しく保存した観測値だけ数える。
   * 同じ不正な値が、更新のたびに、ログを増やさないように）。設備ごとのログに使う。
   */
  readonly rejectedByEquipment: ReadonlyMap<EquipmentId, number>;
  /** 削除済みの設備のレコードの数（棄却数に含めない。Issue #231。ADR-0018 の D-28）。 */
  readonly deletedEquipmentCount: number;
  /** どの設備にも結びつかない、取り込めなかった記録の数（解釈できない行・登録にない識別子・計測日時の誤り。失敗したファイルの 1 件も含む）。 */
  readonly unlinkedRejected: number;
  /** ハウスごとの結果（ファイルに結びつくハウスだけ。#332）。 */
  readonly facilities: readonly FacilityIngestion[];
}

function failedOutcome(
  fileId: string,
  failureKind: FailureKind,
  rejectedCount = 0,
  failedFacilityIds: readonly string[] = [],
): FileOutcome {
  return {
    fileId,
    recordCount: 0,
    rejectedCount,
    failed: true,
    failureKind,
    equipmentIds: [],
    savedByEquipment: new Map(),
    rejectedByEquipment: new Map(),
    unlinkedRejected: rejectedCount,
    deletedEquipmentCount: 0,
    facilities: failedFacilityIds.map((facilityId) => ({
      facilityId,
      result: 'FAILURE',
      recordCount: 0,
    })),
  };
}

/**
 * 設備ごとの取得間隔の判定で、間隔の少し前に起動されても、間隔が来たものとして扱う余裕（ミリ秒）。
 * ジョブ（JB-01）は、1 分ごとに起動するが、起動の時刻は、少しずれる。余裕がないと、1 分の間隔の設備が、2 分に 1 回になる。
 */
const DUE_TOLERANCE_MS = 5000;

/** 設備の取得間隔（最終の開始から）が来ているか。記録のない設備は、来ている（Issue #197。D-11）。 */
function isIntervalDue(
  equipment: Pick<Equipment, 'equipmentType' | 'intervalMinutes'>,
  startedAt: Date | undefined,
  nowMs: number,
): boolean {
  if (startedAt === undefined) {
    return true;
  }
  const intervalMinutes = effectiveIntervalMinutes(equipment) ?? 1;
  return nowMs - startedAt.getTime() + DUE_TOLERANCE_MS >= intervalMinutes * MS_PER_MINUTE;
}

/** 取り込み元の種別に合う設備の、対応表（ファイルの内容・パスから、設備・ハウスを引く）。 */
interface EquipmentIndex {
  /** 取り込み元の種別に合う、有効な設備（取得間隔・ファイルパスを含む）。 */
  readonly members: readonly Equipment[];
  /** データ上の識別子 → 設備。 */
  readonly byExternalId: ReadonlyMap<string, EquipmentId>;
  /** 設備 → 閲覧範囲のハウス（ロボット・センサーは親のハウス）。 */
  readonly facilityOf: ReadonlyMap<EquipmentId, string>;
  /** ファイルのパス（設備の sourceFilePath）→ そのファイルの設備のハウス。 */
  readonly facilitiesByFile: ReadonlyMap<string, readonly string[]>;
  /** 削除済みの設備の、データ上の識別子（登録中の設備にない識別子。Issue #231）。 */
  readonly deletedExternalIds: ReadonlySet<string>;
  /** ファイルのパス（設備の sourceFilePath）→ そのファイルの設備（取り込みログの設備。Issue #201）。 */
  readonly equipmentByFile: ReadonlyMap<string, readonly EquipmentId[]>;
}

/** ハウスごとの結果を、まとめる（同じハウスは、1 つに。失敗が 1 つでもあれば失敗、件数は合計）。 */
function mergeFacilities(entries: readonly FacilityIngestion[]): FacilityIngestion[] {
  const merged = new Map<string, FacilityIngestion>();
  for (const entry of entries) {
    const current = merged.get(entry.facilityId);
    merged.set(
      entry.facilityId,
      current === undefined
        ? entry
        : {
            facilityId: entry.facilityId,
            result:
              current.result === 'FAILURE' || entry.result === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
            recordCount: current.recordCount + entry.recordCount,
          },
    );
  }
  return [...merged.values()].sort((left, right) =>
    left.facilityId.localeCompare(right.facilityId),
  );
}

type StatusCodeMap = ReadonlyMap<string, StatusCodeDefinition>;

function decideResult(counts: {
  filesProcessed: number;
  failedFiles: number;
  recordCount: number;
  rejectedCount: number;
}): IngestionLog['result'] {
  if (counts.filesProcessed === 0 || (counts.failedFiles === 0 && counts.rejectedCount === 0)) {
    return 'SUCCESS';
  }
  return counts.recordCount > 0 ? 'PARTIAL' : 'FAILURE';
}

/**
 * 更新日時がこの時間（ミリ秒）以内のファイルは、書き換えの最中かもしれないため、読まずに、次の周期に回す（D-08）。
 * 同じファイルを、続けて回すのは、この回数まで。時計のずれ・書き換えが続くファイルで、永遠に取り込まれないのを避ける安全策。
 */
const RECENT_WRITE_WINDOW_MS = 1000;
const MAX_CONSECUTIVE_DEFERRALS = 2;

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function createIngestionService(deps: IngestionServiceDeps): IngestionService {
  const { repositories, ingestionSettings, fileSource, profiles, clock, ids, settings, logger } =
    deps;
  const running = new Set<string>();
  /** 続けて次の周期に回したファイルの回数（取り込み元・ファイルごと。プロセスの中だけ。プロセスが替わると、数え直す）。 */
  const deferrals = new Map<string, number>();

  async function findSource(sourceId: string): Promise<IngestionSource> {
    const source = (await ingestionSettings.listSources()).find(
      (candidate) => candidate.sourceId === sourceId,
    );
    if (source === undefined) {
      throw new AppError('NOT_FOUND', '取り込み元が見つかりません');
    }
    return source;
  }

  /** 接続・一覧の取得を、間隔を広げながら再試行する（NFR-4.4）。 */
  async function listFilesWithRetry(
    sourceId: string,
    paths: readonly string[] | undefined,
  ): Promise<Listing> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      try {
        const files = await withTimeout(
          () => fileSource.listFiles(sourceId, paths === undefined ? undefined : { paths }),
          settings.ioTimeoutMs,
          'ファイルの一覧の取得',
        );
        return { ok: true, files, attempts: attempt };
      } catch (error) {
        // 応答がない（タイムアウト）場合は、接続できなかったものとして扱い、再試行する
        lastError =
          error instanceof OperationTimeoutError
            ? new FileSourceUnavailableError('ファイルサーバーが応答しません', { cause: error })
            : error;
        logger.warn('ファイルの一覧の取得に失敗しました', { sourceId, attempt });
        if (attempt < settings.maxAttempts) {
          await clock.sleep(settings.retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    return { ok: false, error: lastError, attempts: settings.maxAttempts };
  }

  function toObservations(
    profile: FormatProfile,
    fileId: string,
    content: string,
    equipmentByExternalId: ReadonlyMap<string, EquipmentId>,
    deletedExternalIds: ReadonlySet<string>,
    statusCodes: StatusCodeMap,
    receivedAt: Date,
  ): {
    observations: Observation[];
    rejectedCount: number;
    deletedEquipmentCount: number;
    unlinkedRejected: number;
    itemRejected: Map<EquipmentId, number>;
  } {
    const parsed = profile.parse(content);
    const observations: Observation[] = [];
    let rejectedCount = parsed.rejectedCount;
    let unlinkedRejected = parsed.rejectedCount;
    let deletedEquipmentCount = 0;
    const itemRejected = new Map<EquipmentId, number>();
    for (const record of parsed.records) {
      const equipmentId = equipmentByExternalId.get(record.externalId);
      // 削除済みの設備のレコードは、保存せず、棄却数にも数えず、別に数える（登録のない識別子は、棄却のまま）
      if (equipmentId === undefined && deletedExternalIds.has(record.externalId)) {
        deletedEquipmentCount += 1;
        continue;
      }
      const observedAtMs = Date.parse(record.observedAt);
      if (equipmentId === undefined || Number.isNaN(observedAtMs)) {
        rejectedCount += 1;
        unlinkedRejected += 1;
        continue;
      }
      const observedAt = new Date(observedAtMs);
      for (const [itemKey, rawValue] of Object.entries(record.fields)) {
        const item = findItemDefinition(itemKey);
        if (item === undefined) {
          rejectedCount += 1;
          itemRejected.set(equipmentId, (itemRejected.get(equipmentId) ?? 0) + 1);
          continue;
        }
        const verdict = classifyValue(itemKey, rawValue, {
          observedAt,
          receivedAt,
          lateAfterMinutes: settings.lateAfterMinutes,
          futureToleranceMinutes: settings.futureToleranceMinutes,
          statusCodes,
        });
        if (isRejectedQuality(verdict.quality)) {
          rejectedCount += 1;
        }
        const keepsRawValue = typeof rawValue === 'number' || typeof rawValue === 'string';
        observations.push({
          equipmentId,
          category: item.category,
          itemKey,
          observedAt: observedAt.toISOString(),
          value: verdict.quality !== 'MISSING' && keepsRawValue ? rawValue : null,
          source: 'AUTO_IMPORT',
          quality: verdict.quality,
          receivedAt: receivedAt.toISOString(),
          sourceFileId: fileId,
          formatProfileVersion: profile.versionLabel,
          isDeleted: false,
        });
      }
    }
    return { observations, rejectedCount, deletedEquipmentCount, unlinkedRejected, itemRejected };
  }

  async function loadStatusCodes(): Promise<StatusCodeMap> {
    const list = await repositories.statusCodes.list({ includeDeleted: true });
    return new Map(list.map((definition) => [definition.code, definition]));
  }

  /**
   * 更新日時が 1 秒以内のファイルは、次の周期に回す（書き換えの最中の、途中までのファイルを読まない。D-08）。
   * 安全策: 更新日時が、こちらの現在時刻より未来のとき、または、同じファイルを続けて 2 周期回したときは、回さずに読む。
   */
  function shouldDeferRecentlyWritten(sourceId: string, file: FileMeta): boolean {
    const key = `${sourceId}\u0000${file.fileId}`;
    const ageMs = clock.now().getTime() - file.modifiedAt.getTime();
    const recentlyWritten = ageMs >= 0 && ageMs <= RECENT_WRITE_WINDOW_MS;
    const count = deferrals.get(key) ?? 0;
    if (!recentlyWritten || count >= MAX_CONSECUTIVE_DEFERRALS) {
      deferrals.delete(key);
      return false;
    }
    deferrals.set(key, count + 1);
    return true;
  }

  /**
   * 変わった観測値だけを選ぶ（D-08）。同じ一意キー（設備・項目・計測日時・取得元）で、値と品質が同じものは、触らない
   * （受信日時も、そのまま。「新しい計測がない」ことを、受信日時で検知できるように）。
   */
  async function selectChanged(observations: readonly Observation[]): Promise<Observation[]> {
    const changed: Observation[] = [];
    for (const observation of observations) {
      const existing = await repositories.observations.findByKey(
        observation.equipmentId,
        observation.itemKey,
        observation.observedAt,
        observation.source,
      );
      const isSame =
        existing?.value === observation.value && existing.quality === observation.quality;
      if (!isSame) {
        changed.push(observation);
      }
    }
    return changed;
  }

  /** 保存した観測値から、ハウスごとの結果（成功。件数は、評価に使える記録）を求める。観測値がなければ、なし。 */
  function facilityResultsOf(
    observations: readonly Observation[],
    equipmentIndex: EquipmentIndex,
  ): FacilityIngestion[] {
    const entries: FacilityIngestion[] = [];
    for (const observation of observations) {
      const facilityId = equipmentIndex.facilityOf.get(observation.equipmentId);
      if (facilityId !== undefined) {
        entries.push({
          facilityId,
          result: 'SUCCESS',
          recordCount: isUsableQuality(observation.quality) ? 1 : 0,
        });
      }
    }
    return mergeFacilities(entries);
  }

  async function processFile(
    source: IngestionSource,
    profile: FormatProfile,
    file: FileMeta,
    equipmentIndex: EquipmentIndex,
    statusCodes: StatusCodeMap,
  ): Promise<FileOutcome | null> {
    const equipmentByExternalId = equipmentIndex.byExternalId;
    const fileFacilityIds = equipmentIndex.facilitiesByFile.get(file.fileId) ?? [];
    const fetchedAt = clock.now();
    // 大きすぎるファイルは、メモリ・実行時間を使い切らないよう、読まずに失敗として扱う
    if (file.sizeBytes > settings.maxFileBytes) {
      logger.warn('ファイルが大きすぎるため、読み込みませんでした', {
        sourceId: source.sourceId,
        fileId: file.fileId,
        sizeBytes: file.sizeBytes,
      });
      return failedOutcome(file.fileId, 'TOO_LARGE', 0, fileFacilityIds);
    }
    if (shouldDeferRecentlyWritten(source.sourceId, file)) {
      logger.info('ファイルが書き換えられた直後のため、次の周期に回します', {
        sourceId: source.sourceId,
        fileId: file.fileId,
      });
      return null;
    }
    let content: string;
    try {
      content = await withTimeout(
        () => fileSource.readFile(source.sourceId, file.fileId),
        settings.ioTimeoutMs,
        'ファイルの読み取り',
      );
    } catch {
      logger.warn('ファイルを読めませんでした', { sourceId: source.sourceId, fileId: file.fileId });
      return failedOutcome(file.fileId, 'READ', 0, fileFacilityIds);
    }
    const contentHash = hashContent(content);
    // 同じファイル（識別子とハッシュ、または内容のハッシュが同じ）は、取り込まない（FR-1.6）
    if (
      (await repositories.ingestion.findIngestedFile(source.sourceId, file.fileId, contentHash)) !==
      undefined
    ) {
      return null;
    }

    try {
      const parsed = toObservations(
        profile,
        file.fileId,
        content,
        equipmentByExternalId,
        equipmentIndex.deletedExternalIds,
        statusCodes,
        fetchedAt,
      );
      const { rejectedCount } = parsed;
      const observations = await selectChanged(parsed.observations);
      await repositories.observations.saveMany(observations);
      const savedCount = observations.filter((observation) =>
        isUsableQuality(observation.quality),
      ).length;
      const rejectedByEquipment = new Map(parsed.itemRejected);
      for (const observation of observations) {
        if (isRejectedQuality(observation.quality)) {
          rejectedByEquipment.set(
            observation.equipmentId,
            (rejectedByEquipment.get(observation.equipmentId) ?? 0) + 1,
          );
        }
      }
      await repositories.ingestion.recordFile({
        sourceId: source.sourceId,
        fileId: file.fileId,
        contentHash,
        fetchedAt: fetchedAt.toISOString(),
        result: 'SUCCESS',
        recordCount: savedCount,
      });
      if (observations.length > 0) {
        await deps.federation.enqueue({
          targetType: 'OBSERVATION',
          targetRef: `${source.sourceId}#${file.fileId}`,
          payload: { sourceId: source.sourceId, fileId: file.fileId, observations },
        });
      }
      const savedByEquipment = new Map<EquipmentId, number>();
      for (const observation of observations) {
        savedByEquipment.set(
          observation.equipmentId,
          (savedByEquipment.get(observation.equipmentId) ?? 0) +
            (isUsableQuality(observation.quality) ? 1 : 0),
        );
      }
      return {
        fileId: file.fileId,
        recordCount: savedCount,
        rejectedCount,
        failed: false,
        equipmentIds: [...new Set(observations.map((observation) => observation.equipmentId))],
        savedByEquipment,
        rejectedByEquipment,
        unlinkedRejected: parsed.unlinkedRejected,
        deletedEquipmentCount: parsed.deletedEquipmentCount,
        facilities: facilityResultsOf(observations, equipmentIndex),
      };
    } catch (error) {
      if (!(error instanceof FormatError)) {
        // 想定外の例外（保存の失敗など）。取り込み済みの記録は作らない（次回、再び取り込む）。
        // 原因を残し、呼び出し元へ伝える（取り込みログ・通知は、runSourceUnlocked が残す）
        logger.error('ファイルの取り込みに失敗しました', {
          sourceId: source.sourceId,
          fileId: file.fileId,
          ...errorLogFields(error),
        });
        throw error;
      }
      // 形式違いのファイルは、区別して記録し、取り込みを継続する（FR-1.6）
      await repositories.ingestion.recordFile({
        sourceId: source.sourceId,
        fileId: file.fileId,
        contentHash,
        fetchedAt: fetchedAt.toISOString(),
        result: 'FAILURE',
        recordCount: 0,
        errorMessage: FAILURE_REASONS.FORMAT,
      });
      return failedOutcome(file.fileId, 'FORMAT', 1, fileFacilityIds);
    }
  }

  /** 取り込みの結果のログを書く（1回の実行につき1件）。 */
  async function writeLog(
    source: IngestionSource,
    profile: FormatProfile,
    startedAt: Date,
    outcome: Omit<IngestionRunSummary, 'sourceId' | 'deletedEquipmentCount'> & {
      readonly errorMessage?: string;
      readonly facilities?: readonly FacilityIngestion[];
      /** ログの設備（設備ごとのログ）。なければ、取り込み元単位のログ。 */
      readonly equipmentId?: EquipmentId;
      /** 削除済みの設備のレコードの数（取り込み元単位のログだけ。0 は持たない）。 */
      readonly deletedEquipmentCount?: number;
    },
  ): Promise<void> {
    await repositories.ingestion.addLog({
      logId: ids.next(),
      sourceId: source.sourceId,
      ...(outcome.equipmentId === undefined ? {} : { equipmentId: outcome.equipmentId }),
      ...(outcome.deletedEquipmentCount === undefined || outcome.deletedEquipmentCount === 0
        ? {}
        : { deletedEquipmentCount: outcome.deletedEquipmentCount }),
      startedAt: startedAt.toISOString(),
      finishedAt: clock.now().toISOString(),
      result: outcome.result,
      filesProcessed: outcome.filesProcessed,
      recordCount: outcome.recordCount,
      rejectedCount: outcome.rejectedCount,
      attempts: outcome.attempts,
      formatProfileVersion: profile.versionLabel,
      ...omitUndefined({ errorMessage: outcome.errorMessage }),
      ...(outcome.facilities !== undefined && outcome.facilities.length > 0
        ? { facilities: [...outcome.facilities] }
        : {}),
    });
  }

  /**
   * 実行の結果を、設備ごとの結果と、設備に結びつかない結果に分ける（Issue #201）。
   * ファイルが 1 つの設備のもの（設備のファイルパス。HTTP）で、その設備の記録だけを含むときは、ファイルの結果のすべてを、その設備の結果にする。
   * 1 つのファイルに複数の設備が入る場合（モック・S3。または、設備のファイルに、ほかの設備の記録が入る場合）は、設備ごとの記録の数だけを、設備の結果にする。
   * 取り込めなかった記録・取り込めなかったファイル（設備が分からない）は、設備に結びつかない結果（取り込み元単位）にする。
   */
  function attributeOutcomes(
    outcomes: readonly (FileOutcome | null)[],
    equipmentIndex: EquipmentIndex,
  ): {
    readonly perEquipment: ReadonlyMap<EquipmentId, Tally>;
    readonly unlinked: Tally;
    readonly unlinkedFacilities: readonly FacilityIngestion[];
    /** 削除済みの設備のレコードの数（この実行のすべてのファイルの合計）。 */
    readonly deletedEquipmentCount: number;
  } {
    let deletedEquipmentCount = 0;
    const perEquipment = new Map<EquipmentId, Tally>();
    const unlinked = emptyTally();
    const unlinkedFacilities: FacilityIngestion[] = [];
    const tallyOf = (equipmentId: EquipmentId): Tally => {
      const found = perEquipment.get(equipmentId) ?? emptyTally();
      perEquipment.set(equipmentId, found);
      return found;
    };
    for (const outcome of outcomes) {
      if (outcome === null) {
        continue;
      }
      deletedEquipmentCount += outcome.deletedEquipmentCount;
      const owners = equipmentIndex.equipmentByFile.get(outcome.fileId) ?? [];
      const owner = owners.length === 1 ? owners[0] : undefined;
      const involved = new Set([
        ...outcome.savedByEquipment.keys(),
        ...outcome.rejectedByEquipment.keys(),
      ]);
      if (owner !== undefined && [...involved].every((id) => id === owner)) {
        const tally = tallyOf(owner);
        tally.filesProcessed += 1;
        tally.recordCount += outcome.recordCount;
        tally.rejectedCount +=
          (outcome.rejectedByEquipment.get(owner) ?? 0) + outcome.unlinkedRejected;
        tally.failedFiles += outcome.failed ? 1 : 0;
        continue;
      }
      // 記録を保存した設備が 1 つだけのファイルは、結びつかない記録（解釈できない行など）も、その設備のログに数える
      // （1 つの設備のファイルの結果が、2 件のログに分かれないように）。新しい記録がないときは、数えない（同じ行が、ログを増やさない）
      const sole = involved.size === 1 ? [...involved][0] : undefined;
      const soleHasData = sole !== undefined && (outcome.savedByEquipment.get(sole) ?? 0) > 0;
      for (const equipmentId of involved) {
        const tally = tallyOf(equipmentId);
        tally.filesProcessed += 1;
        tally.recordCount += outcome.savedByEquipment.get(equipmentId) ?? 0;
        tally.rejectedCount += outcome.rejectedByEquipment.get(equipmentId) ?? 0;
        if (soleHasData) {
          tally.rejectedCount += outcome.unlinkedRejected;
        }
      }
      if (soleHasData && !outcome.failed) {
        continue;
      }
      if (outcome.failed || outcome.unlinkedRejected > 0) {
        unlinked.filesProcessed += 1;
        unlinked.rejectedCount += outcome.unlinkedRejected;
        unlinked.failedFiles += outcome.failed ? 1 : 0;
        if (outcome.failed) {
          unlinkedFacilities.push(...outcome.facilities);
        }
      }
    }
    return {
      perEquipment,
      unlinked,
      unlinkedFacilities: mergeFacilities(unlinkedFacilities),
      deletedEquipmentCount,
    };
  }

  /**
   * 取り込みのログを書く（Issue #201。ADR-0016 の D-48）。新しいデータがあった設備・取り込めなかった設備ごとに、1 件ずつ。
   * 設備に結びつかない結果（取り込めなかった記録・ファイル）は、取り込み元単位で、1 件。空振り（新しいデータがない成功）は、残さない。
   */
  async function writeRunLogs(
    source: IngestionSource,
    profile: FormatProfile,
    startedAt: Date,
    attempts: number,
    attribution: ReturnType<typeof attributeOutcomes>,
    equipmentIndex: EquipmentIndex,
  ): Promise<void> {
    for (const [equipmentId, tally] of attribution.perEquipment) {
      if (tally.recordCount === 0 && tally.rejectedCount === 0 && tally.failedFiles === 0) {
        continue;
      }
      const facilityId = equipmentIndex.facilityOf.get(equipmentId);
      await writeLog(source, profile, startedAt, {
        equipmentId,
        result: decideResult(tally),
        filesProcessed: tally.filesProcessed,
        recordCount: tally.recordCount,
        rejectedCount: tally.rejectedCount,
        attempts,
        ...(tally.failedFiles > 0
          ? { errorMessage: `${String(tally.failedFiles)}件のファイルを取り込めませんでした` }
          : {}),
        ...(facilityId === undefined
          ? {}
          : {
              facilities: [
                {
                  facilityId,
                  result: tally.failedFiles > 0 ? 'FAILURE' : 'SUCCESS',
                  recordCount: tally.recordCount,
                },
              ],
            }),
      });
    }
    const { unlinked } = attribution;
    if (unlinked.rejectedCount > 0 || unlinked.failedFiles > 0) {
      await writeLog(source, profile, startedAt, {
        // 取り込めなかったファイルがあれば、失敗。取り込めなかった記録だけなら、一部成功
        result: unlinked.failedFiles > 0 ? 'FAILURE' : 'PARTIAL',
        filesProcessed: unlinked.filesProcessed,
        recordCount: 0,
        rejectedCount: unlinked.rejectedCount,
        deletedEquipmentCount: attribution.deletedEquipmentCount,
        attempts,
        ...(unlinked.failedFiles > 0
          ? { errorMessage: `${String(unlinked.failedFiles)}件のファイルを取り込めませんでした` }
          : {}),
        facilities: attribution.unlinkedFacilities,
      });
    }
  }

  /**
   * 設備ごとの最終の実行を記録する（1 回の実行につき、設備ごとに 1 回の書き込み。Issue #201）。`perEquipment` がなければ、失敗。
   * 設備が 1 つもない取り込み元は、取り込み元ごとの開始日時を、実行の開始のときに記録している。
   */
  async function recordEquipmentRuns(
    members: readonly Equipment[],
    startedAt: Date,
    perEquipment: ReadonlyMap<EquipmentId, Tally> | undefined,
  ): Promise<void> {
    const finishedAt = clock.now();
    await repositories.ingestion.recordEquipmentRuns(
      members.map((member) => {
        const tally = perEquipment?.get(member.equipmentId);
        return {
          equipmentId: member.equipmentId,
          startedAt,
          finishedAt,
          result:
            perEquipment === undefined
              ? 'FAILURE'
              : tally === undefined
                ? 'SUCCESS'
                : decideResult(tally),
          dataIngested: tally !== undefined && tally.recordCount > 0,
        };
      }),
    );
  }

  /** ファイルの一覧を取得できなかった場合: 失敗のログを書き、取り込み失敗を通知する（UC-24。FR-7.4）。 */
  async function handleListingFailure(
    source: IngestionSource,
    profile: FormatProfile,
    startedAt: Date,
    listing: Extract<Listing, { ok: false }>,
  ): Promise<IngestionRunSummary> {
    const reason =
      listing.error instanceof FileSourceUnavailableError
        ? 'ファイルサーバーに接続できませんでした'
        : 'ファイルの一覧を取得できませんでした';
    const summary: IngestionRunSummary = {
      sourceId: source.sourceId,
      result: 'FAILURE',
      filesProcessed: 0,
      recordCount: 0,
      rejectedCount: 0,
      deletedEquipmentCount: 0,
      attempts: listing.attempts,
    };
    await writeLog(source, profile, startedAt, { ...summary, errorMessage: reason });
    // 再試行しても失敗した場合は、取り込み失敗を通知する
    await notifyFailureSafely(source, reason);
    return summary;
  }

  /** 設備の対応表（取り込み元の種別と同じ種別の設備のみ）。 */
  async function loadEquipmentIndex(source: IngestionSource): Promise<EquipmentIndex> {
    // 取り込み元の種別（ROBOT・SENSOR）は、対応する設備の種別と同じ文字列
    const equipmentType: Equipment['equipmentType'] = source.kind;
    const byExternalId = new Map<string, EquipmentId>();
    const facilityOf = new Map<EquipmentId, string>();
    const facilitiesByFile = new Map<string, string[]>();
    const equipmentByFile = new Map<string, EquipmentId[]>();
    const members: Equipment[] = [];
    const deletedExternalIds = new Set<string>();
    for (const equipment of await repositories.equipment.list({ includeDeleted: true })) {
      if (equipment.equipmentType !== equipmentType) {
        continue;
      }
      if (equipment.isDeleted) {
        // 削除済みの設備（記録が残っているもの）のデータ上の識別子
        if (equipment.externalId !== undefined) {
          deletedExternalIds.add(equipment.externalId);
        }
        continue;
      }
      members.push(equipment);
      // 通知と同じく、閲覧範囲のハウスは、親のハウス（なければ設備自身）
      const facilityId = equipment.facilityId ?? equipment.equipmentId;
      facilityOf.set(equipment.equipmentId, facilityId);
      if (equipment.externalId !== undefined) {
        byExternalId.set(equipment.externalId, equipment.equipmentId);
      }
      if (equipment.sourceFilePath !== undefined) {
        const known = facilitiesByFile.get(equipment.sourceFilePath) ?? [];
        if (!known.includes(facilityId)) {
          known.push(facilityId);
        }
        facilitiesByFile.set(equipment.sourceFilePath, known);
        equipmentByFile.set(equipment.sourceFilePath, [
          ...(equipmentByFile.get(equipment.sourceFilePath) ?? []),
          equipment.equipmentId,
        ]);
      }
    }
    // 設備の記録が消えた（#229）あとも判定できるよう、削除のときに別に残した識別子も、加える
    for (const entry of await listDeletedExternalIds(repositories.settings)) {
      if (entry.equipmentType === equipmentType) {
        deletedExternalIds.add(entry.externalId);
      }
    }
    // 同じ識別子で、登録し直した設備（登録中）は、削除済みとして扱わない（D-28: 再登録を許す）
    for (const externalId of byExternalId.keys()) {
      deletedExternalIds.delete(externalId);
    }
    return {
      members,
      byExternalId,
      deletedExternalIds,
      facilityOf,
      facilitiesByFile,
      equipmentByFile,
    };
  }

  /** ファイルごとの結果（取り込み済みで対象外の null を除く）を、件数に集計する。 */
  function tallyOutcomes(outcomes: readonly (FileOutcome | null)[]): Pick<
    IngestionRunSummary,
    'filesProcessed' | 'recordCount' | 'rejectedCount' | 'deletedEquipmentCount'
  > & {
    readonly failedFiles: number;
    /** 最初に失敗したファイルの理由（通知の文言に使う）。 */
    readonly firstFailureKind: FailureKind | undefined;
    /** 観測値を保存した設備（評価し直す設備）。 */
    readonly affectedEquipmentIds: readonly EquipmentId[];
    /** ハウスごとの結果（#332）。 */
    readonly facilities: readonly FacilityIngestion[];
  } {
    const affected = new Set<EquipmentId>();
    const facilityEntries: FacilityIngestion[] = [];
    let filesProcessed = 0;
    let recordCount = 0;
    let rejectedCount = 0;
    let deletedEquipmentCount = 0;
    let failedFiles = 0;
    let firstFailureKind: FailureKind | undefined;
    for (const outcome of outcomes) {
      if (outcome === null) {
        continue;
      }
      filesProcessed += 1;
      recordCount += outcome.recordCount;
      rejectedCount += outcome.rejectedCount;
      deletedEquipmentCount += outcome.deletedEquipmentCount;
      failedFiles += outcome.failed ? 1 : 0;
      firstFailureKind ??= outcome.failureKind;
      for (const equipmentId of outcome.equipmentIds) {
        affected.add(equipmentId);
      }
      facilityEntries.push(...outcome.facilities);
    }
    return {
      filesProcessed,
      recordCount,
      rejectedCount,
      deletedEquipmentCount,
      failedFiles,
      firstFailureKind,
      affectedEquipmentIds: [...affected],
      facilities: mergeFacilities(facilityEntries),
    };
  }

  /** 取り込み失敗を通知する。通知の失敗は、取り込みの結果に影響させない（ログに残す）。 */
  async function notifyFailureSafely(source: IngestionSource, reason: string): Promise<void> {
    try {
      await deps.notifications.notifyIngestionFailure({
        sourceId: source.sourceId,
        sourceName: sourceDisplayName(source.sourceId),
        reason,
      });
    } catch (error) {
      logger.error('取り込み失敗の通知に失敗しました', {
        sourceId: source.sourceId,
        ...errorLogFields(error),
      });
    }
  }

  /**
   * 新しいデータが届かなくなった設備を、「データ取得の停止」として通知する（V-018。無音の停止の検知）。
   * 取り込みは、ファイルが0件でも成功になるため、設備ごとの基準（その設備の取得間隔 × 基準の倍数、最低 3 分。Issue #198。
   * ADR-0016 の D-12）を超えて、新しいデータ（自動取り込みの受信）がない設備を、停止とみなす。一度もデータを取り込んでいない
   * 設備（未取得）は、対象外。通知は、取り込み元ごとに 1 件で、止まった設備の名前をまとめる（重複の抑制は、取り込み元ごと）。
   * 暫定仕様（dev_spec.md 4章）。環境変数 INGESTION_STOP_NOTIFICATION_ENABLED で、無効にできる。
   * `equipmentRead` は、取り込みの判定で、すでに読み始めた設備の一覧（読めなかった失敗は、取り込みの失敗として、伝え済み）。
   */
  async function notifyStoppedSources(
    now: Date,
    equipmentRead?: Promise<Equipment[]>,
  ): Promise<void> {
    if (!settings.stopNotificationEnabled) {
      return;
    }
    let equipment: Equipment[];
    try {
      equipment = await (equipmentRead ?? repositories.equipment.list());
    } catch (error) {
      if (equipmentRead === undefined) {
        throw error;
      }
      return;
    }
    const sources = (await ingestionSettings.listSources()).filter((source) => source.isEnabled);
    if (sources.length === 0) {
      return;
    }
    // 自動取り込みの対象でない設備（取得先がない。手動のみの運用）は、対象にしない（Issue #202）
    const targets = equipment.filter(
      (item) =>
        !item.isDeleted &&
        item.equipmentType !== 'FACILITY' &&
        isAutoIngestionTarget(item, sources),
    );
    const receivedAt = await repositories.observations.receivedAtByEquipment(
      targets.map((item) => item.equipmentId),
      { autoImportOnly: true },
    );
    for (const source of sources) {
      const stopped = targets
        .filter((item) => {
          const received = receivedAt.get(item.equipmentId);
          const thresholdMinutes = staleThresholdMinutesOf(item, settings.stopAfterIntervals);
          return (
            item.equipmentType === source.kind &&
            received !== undefined &&
            thresholdMinutes !== undefined &&
            now.getTime() - received.getTime() > thresholdMinutes * MS_PER_MINUTE
          );
        })
        .sort((left, right) => left.equipmentId.localeCompare(right.equipmentId));
      if (stopped.length === 0) {
        continue;
      }
      try {
        await deps.notifications.notifyIngestionFailure({
          sourceId: source.sourceId,
          sourceName: sourceDisplayName(source.sourceId),
          reason: `${stoppedEquipmentNames(stopped)}で、設備ごとの基準（取得間隔 × ${String(settings.stopAfterIntervals)}、最低 ${String(MIN_STALE_THRESHOLD_MINUTES)} 分）を超えて、新しいデータが届いていません。ロボット・センサーとファイルの出力を確認してください`,
          situation: 'STOPPED',
        });
      } catch (error) {
        logger.error('データ取得の停止の通知に失敗しました', {
          sourceId: source.sourceId,
          ...errorLogFields(error),
        });
      }
    }
  }

  /**
   * 取り込み元を 1 回、実行する。`dueEquipmentIds` を指定すると（接続方式 HTTP。設備ごとのファイル）、その設備のファイルだけを取り込む
   * （設備ごとの取得間隔。Issue #197）。指定がなければ、すべての設備（即時取得）。モック・S3 は、1 つのファイルに複数の設備が入るため、
   * 指定にかかわらず、ファイル全体を取り込む。取り込む設備の、開始の日時を記録する（失敗しても、間隔が来るまで、再試行しない）。
   */
  async function runSourceUnlocked(
    source: IngestionSource,
    dueEquipmentIds?: ReadonlySet<EquipmentId>,
  ): Promise<IngestionRunSummary> {
    const startedAt = clock.now();
    const profile = profiles.get(source.profileId);
    if (profile === undefined) {
      throw new AppError('INTERNAL_ERROR', '取り込みの設定に誤りがあります');
    }

    const equipmentIndex = await loadEquipmentIndex(source);
    const isHttp = source.connection.type === 'HTTP';
    const fetched = isHttp
      ? equipmentIndex.members.filter(
          (member) =>
            member.sourceFilePath !== undefined &&
            (dueEquipmentIds === undefined || dueEquipmentIds.has(member.equipmentId)),
        )
      : equipmentIndex.members;
    if (equipmentIndex.members.length === 0) {
      // 設備が 1 つもない取り込み元は、取り込み元ごとの開始日時で、取得間隔を判定する
      await repositories.ingestion.recordSourceStarted(source.sourceId, startedAt);
    }
    const paths =
      isHttp && dueEquipmentIds !== undefined
        ? fetched.flatMap((member) => member.sourceFilePath ?? [])
        : undefined;

    const listing = await listFilesWithRetry(source.sourceId, paths);
    if (!listing.ok) {
      const failed = await handleListingFailure(source, profile, startedAt, listing);
      await recordEquipmentRuns(fetched, startedAt, undefined);
      return failed;
    }

    const statusCodes = await loadStatusCodes();

    // ファイルは、一覧の順に1つずつ処理する（並列にしない。保存・ログの順序を保つ）
    const outcomes: (FileOutcome | null)[] = [];
    try {
      for (const file of listing.files) {
        outcomes.push(await processFile(source, profile, file, equipmentIndex, statusCodes));
      }
    } catch (error) {
      // 想定外の例外でも、取り込みログ（失敗）と通知を残してから、呼び出し元へ伝える（V-046）
      const tally = tallyOutcomes(outcomes);
      await writeLog(source, profile, startedAt, {
        result: 'FAILURE',
        filesProcessed: tally.filesProcessed,
        recordCount: tally.recordCount,
        rejectedCount: tally.rejectedCount,
        attempts: listing.attempts,
        errorMessage: FAILURE_REASONS.UNEXPECTED,
        facilities: tally.facilities,
      });
      await recordEquipmentRuns(fetched, startedAt, undefined);
      await notifyFailureSafely(source, FAILURE_REASONS.UNEXPECTED);
      throw error;
    }
    const { failedFiles, firstFailureKind, affectedEquipmentIds, ...counts } =
      tallyOutcomes(outcomes);
    const result = decideResult({ ...counts, failedFiles });
    const summary: IngestionRunSummary = {
      sourceId: source.sourceId,
      result,
      ...counts,
      attempts: listing.attempts,
    };
    const attribution = attributeOutcomes(outcomes, equipmentIndex);
    // 設備ごとの最終の実行を、先に記録する（設備ごとのログは、設備の一覧〔最終の実行の項目〕から探すため。DynamoDB）
    await recordEquipmentRuns(fetched, startedAt, attribution.perEquipment);
    await writeRunLogs(source, profile, startedAt, listing.attempts, attribution, equipmentIndex);
    // ファイル単位の失敗（読み取り・形式違い・大きさ）は、設定で有効にした場合のみ通知する（FR-7.4。重複は抑制する。V-017）
    if (failedFiles > 0 && firstFailureKind !== undefined && settings.notifyFileFailures) {
      await notifyFailureSafely(source, FAILURE_REASONS[firstFailureKind]);
    }

    if (counts.recordCount > 0) {
      // 取り込み後に評価を更新する（FR-5.4）。評価の失敗は、取り込みの結果に影響させない
      try {
        await deps.evaluation.evaluateAffected('INGESTION', affectedEquipmentIds);
      } catch (error) {
        logger.error('取り込み後の評価に失敗しました', {
          sourceId: source.sourceId,
          ...errorLogFields(error),
        });
      }
    }
    return summary;
  }

  async function runLocked(
    sourceId: string,
    dueEquipmentIds?: ReadonlySet<EquipmentId>,
  ): Promise<IngestionRunSummary> {
    const source = await findSource(sourceId);
    if (running.has(sourceId)) {
      throw new AppError('CONFLICT', '取り込みを実行中です');
    }
    running.add(sourceId);
    try {
      return await runSourceUnlocked(source, dueEquipmentIds);
    } finally {
      running.delete(sourceId);
    }
  }

  function runSource(sourceId: string): Promise<IngestionRunSummary> {
    return runLocked(sourceId);
  }

  /**
   * 取得間隔が来た設備の取り込み（設備ごと。Issue #197）。接続方式 HTTP は、間隔が来た設備のファイルだけ。
   * モック・S3 は、その取り込み元の設備の、どれかの間隔が来たら、ファイル全体（最短の間隔で動く）。設備が 1 つもない種別は、
   * 種別ごとの既定の間隔（取り込み元ごとの最終の開始から）。来ていなければ、undefined（実行しない）。
   */
  async function dueScopeOf(
    source: IngestionSource,
    members: readonly Equipment[],
    states: ReadonlyMap<string, Date>,
    nowMs: number,
  ): Promise<{ readonly dueEquipmentIds?: ReadonlySet<EquipmentId> } | undefined> {
    const dueOf = (items: readonly Equipment[]): Equipment[] =>
      items.filter((item) => isIntervalDue(item, states.get(item.equipmentId), nowMs));
    if (source.connection.type === 'HTTP') {
      const due = dueOf(members.filter((member) => member.sourceFilePath !== undefined));
      return due.length === 0
        ? undefined
        : { dueEquipmentIds: new Set(due.map((item) => item.equipmentId)) };
    }
    if (members.length > 0) {
      return dueOf(members).length === 0 ? undefined : {};
    }
    const lastStartedAt = await repositories.ingestion.lastStartedAt(source.sourceId);
    return isIntervalDue({ equipmentType: source.kind }, lastStartedAt ?? undefined, nowMs)
      ? {}
      : undefined;
  }

  return {
    runSource,

    isRunning: (sourceId) => running.has(sourceId),

    async runDueSources() {
      const now = clock.now();
      const summaries: IngestionRunSummary[] = [];
      const failures: unknown[] = [];
      // 設備と、取り込みの開始の記録は、最初に必要になったときに、1 回だけ読む（取り込み元ごとに読まない）。読めなかった場合は、
      // どの取り込み元も、その失敗を受ける（取り込み元ごとの失敗として、まとめて伝える。V-058）
      let equipmentRead: Promise<Equipment[]> | undefined;
      let statesRead: Promise<ReadonlyMap<string, Date>> | undefined;
      const startedAtOf = async (): Promise<ReadonlyMap<string, Date>> =>
        new Map(
          [...(await repositories.ingestion.listEquipmentRuns())].map(([equipmentId, state]) => [
            equipmentId,
            state.startedAt,
          ]),
        );
      for (const source of await ingestionSettings.listSources()) {
        if (!source.isEnabled || running.has(source.sourceId)) {
          continue;
        }
        // 取り込み元ごとに独立して実行する。想定外のエラーで1つが失敗しても、他の取り込み元は実行する
        try {
          equipmentRead ??= repositories.equipment.list();
          statesRead ??= startedAtOf();
          const members = (await equipmentRead).filter(
            (item) => item.equipmentType === source.kind,
          );
          const scope = await dueScopeOf(source, members, await statesRead, now.getTime());
          if (scope !== undefined) {
            summaries.push(await runLocked(source.sourceId, scope.dueEquipmentIds));
          }
        } catch (error) {
          logger.error('取り込みに失敗しました', {
            sourceId: source.sourceId,
            ...errorLogFields(error),
          });
          failures.push(error);
        }
      }
      // 新しいデータが届かなくなった取り込み元を通知する（取り込みの失敗の有無にかかわらず判定する）
      await notifyStoppedSources(clock.now(), equipmentRead);
      // 握りつぶさず、すべての取り込み元の実行後に、エラーを呼び出し元（ジョブ）へ伝える。
      // 複数の取り込み元で失敗した場合は、すべてをまとめる（V-058）
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `${String(failures.length)}件の取り込み元で失敗しました`,
        );
      }
      return summaries;
    },

    async testConnection(sourceId) {
      await findSource(sourceId);
      try {
        await withTimeout(
          () => fileSource.testConnection(sourceId),
          settings.ioTimeoutMs,
          'ファイルサーバーへの接続テスト',
        );
        return { ok: true, message: '接続できました' };
      } catch (error) {
        // 理由が分かる失敗（FileSourceFailure）は、理由を示す（接続先・認証情報を含まない固定の文言）
        const reason = error instanceof FileSourceFailure ? `（${error.message}）` : '';
        return {
          ok: false,
          message: `接続できませんでした${reason}。接続先と認証情報の設定を確認してください`,
        };
      }
    },
  };
}

/**
 * 取り込みのユースケース（UC-08, UC-09, UC-15, UC-24。JB-01。FR-1、data-flow.md 3章）。
 * 取得（FileSourcePort）→ 取り込み済みの判定 → 解釈（FormatProfile）→ 検証 → 保存 → ログ → 評価の更新。
 * 取り込み元ごとに独立して実行・再試行し、1つの失敗が他の取り込み元・他の機能を止めない（FR-1.9）。
 * 再試行しても取得できない場合は、取り込み失敗の通知を作る（UC-24）。
 */

import { createHash } from 'node:crypto';
import { findItemDefinition } from '@smart-farm/shared/constants/items';
import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import type {
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
import { sourceDisplayName, type IngestionSettings } from './ingestion-settings.ts';

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
    'equipment' | 'observations' | 'statusCodes' | 'ingestion'
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
  readonly recordCount: number;
  readonly rejectedCount: number;
  readonly failed: boolean;
  /** 失敗した場合の理由（failed が true のとき）。 */
  readonly failureKind?: FailureKind;
  /** 観測値を保存した設備（評価し直す設備）。 */
  readonly equipmentIds: readonly EquipmentId[];
}

function failedOutcome(failureKind: FailureKind, rejectedCount = 0): FileOutcome {
  return { recordCount: 0, rejectedCount, failed: true, failureKind, equipmentIds: [] };
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

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function createIngestionService(deps: IngestionServiceDeps): IngestionService {
  const { repositories, ingestionSettings, fileSource, profiles, clock, ids, settings, logger } =
    deps;
  const running = new Set<string>();

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
  async function listFilesWithRetry(sourceId: string): Promise<Listing> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      try {
        const files = await withTimeout(
          () => fileSource.listFiles(sourceId),
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
    statusCodes: StatusCodeMap,
    receivedAt: Date,
  ): { observations: Observation[]; rejectedCount: number } {
    const parsed = profile.parse(content);
    const observations: Observation[] = [];
    let rejectedCount = parsed.rejectedCount;
    for (const record of parsed.records) {
      const equipmentId = equipmentByExternalId.get(record.externalId);
      const observedAtMs = Date.parse(record.observedAt);
      if (equipmentId === undefined || Number.isNaN(observedAtMs)) {
        rejectedCount += 1;
        continue;
      }
      const observedAt = new Date(observedAtMs);
      for (const [itemKey, rawValue] of Object.entries(record.fields)) {
        const item = findItemDefinition(itemKey);
        if (item === undefined) {
          rejectedCount += 1;
          continue;
        }
        const verdict = classifyValue(itemKey, rawValue, {
          observedAt,
          receivedAt,
          lateAfterMinutes: settings.lateAfterMinutes,
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
    return { observations, rejectedCount };
  }

  async function loadStatusCodes(): Promise<StatusCodeMap> {
    const list = await repositories.statusCodes.list({ includeDeleted: true });
    return new Map(list.map((definition) => [definition.code, definition]));
  }

  async function processFile(
    source: IngestionSource,
    profile: FormatProfile,
    file: FileMeta,
    equipmentByExternalId: ReadonlyMap<string, EquipmentId>,
    statusCodes: StatusCodeMap,
  ): Promise<FileOutcome | null> {
    const fetchedAt = clock.now();
    // 大きすぎるファイルは、メモリ・実行時間を使い切らないよう、読まずに失敗として扱う
    if (file.sizeBytes > settings.maxFileBytes) {
      logger.warn('ファイルが大きすぎるため、読み込みませんでした', {
        sourceId: source.sourceId,
        fileId: file.fileId,
        sizeBytes: file.sizeBytes,
      });
      return failedOutcome('TOO_LARGE');
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
      return failedOutcome('READ');
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
      const { observations, rejectedCount } = toObservations(
        profile,
        file.fileId,
        content,
        equipmentByExternalId,
        statusCodes,
        fetchedAt,
      );
      await repositories.observations.saveMany(observations);
      const savedCount = observations.filter((observation) =>
        isUsableQuality(observation.quality),
      ).length;
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
      return {
        recordCount: savedCount,
        rejectedCount,
        failed: false,
        equipmentIds: [...new Set(observations.map((observation) => observation.equipmentId))],
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
      return failedOutcome('FORMAT', 1);
    }
  }

  /** 取り込みの結果のログを書く（1回の実行につき1件）。 */
  async function writeLog(
    source: IngestionSource,
    profile: FormatProfile,
    startedAt: Date,
    outcome: Omit<IngestionRunSummary, 'sourceId'> & { readonly errorMessage?: string },
  ): Promise<void> {
    await repositories.ingestion.addLog({
      logId: ids.next(),
      sourceId: source.sourceId,
      startedAt: startedAt.toISOString(),
      finishedAt: clock.now().toISOString(),
      result: outcome.result,
      filesProcessed: outcome.filesProcessed,
      recordCount: outcome.recordCount,
      rejectedCount: outcome.rejectedCount,
      attempts: outcome.attempts,
      formatProfileVersion: profile.versionLabel,
      ...omitUndefined({ errorMessage: outcome.errorMessage }),
    });
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
      attempts: listing.attempts,
    };
    await writeLog(source, profile, startedAt, { ...summary, errorMessage: reason });
    // 再試行しても失敗した場合は、取り込み失敗を通知する
    await notifyFailureSafely(source, reason);
    return summary;
  }

  /** 設備のデータ上の識別子（externalId）から設備の識別子を引く表（取り込み元の種別と同じ種別の設備のみ）。 */
  async function loadEquipmentByExternalId(
    source: IngestionSource,
  ): Promise<Map<string, EquipmentId>> {
    // 取り込み元の種別（ROBOT・SENSOR）は、対応する設備の種別と同じ文字列
    const equipmentType: Equipment['equipmentType'] = source.kind;
    const equipmentByExternalId = new Map<string, EquipmentId>();
    for (const equipment of await repositories.equipment.list()) {
      if (equipment.equipmentType === equipmentType && equipment.externalId !== undefined) {
        equipmentByExternalId.set(equipment.externalId, equipment.equipmentId);
      }
    }
    return equipmentByExternalId;
  }

  /** ファイルごとの結果（取り込み済みで対象外の null を除く）を、件数に集計する。 */
  function tallyOutcomes(outcomes: readonly (FileOutcome | null)[]): Pick<
    IngestionRunSummary,
    'filesProcessed' | 'recordCount' | 'rejectedCount'
  > & {
    readonly failedFiles: number;
    /** 最初に失敗したファイルの理由（通知の文言に使う）。 */
    readonly firstFailureKind: FailureKind | undefined;
    /** 観測値を保存した設備（評価し直す設備）。 */
    readonly affectedEquipmentIds: readonly EquipmentId[];
  } {
    const affected = new Set<EquipmentId>();
    let filesProcessed = 0;
    let recordCount = 0;
    let rejectedCount = 0;
    let failedFiles = 0;
    let firstFailureKind: FailureKind | undefined;
    for (const outcome of outcomes) {
      if (outcome === null) {
        continue;
      }
      filesProcessed += 1;
      recordCount += outcome.recordCount;
      rejectedCount += outcome.rejectedCount;
      failedFiles += outcome.failed ? 1 : 0;
      firstFailureKind ??= outcome.failureKind;
      for (const equipmentId of outcome.equipmentIds) {
        affected.add(equipmentId);
      }
    }
    return {
      filesProcessed,
      recordCount,
      rejectedCount,
      failedFiles,
      firstFailureKind,
      affectedEquipmentIds: [...affected],
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
   * 新しいデータが届かなくなった取り込み元を、「データ取得の停止」として通知する（V-018。無音の停止の検知）。
   * 取り込みは、ファイルが0件でも成功になるため、取得間隔×基準の倍数を超えて、新しいデータ（1件以上の記録）が
   * 取り込まれていない場合を、停止とみなす。一度もデータを取り込んでいない取り込み元（未取得）は、対象外。
   * 暫定仕様（dev_spec.md 4章）。環境変数 INGESTION_STOP_NOTIFICATION_ENABLED で、無効にできる。
   */
  async function notifyStoppedSources(now: Date): Promise<void> {
    if (!settings.stopNotificationEnabled) {
      return;
    }
    for (const source of await ingestionSettings.listSources()) {
      if (!source.isEnabled) {
        continue;
      }
      const lastDataAt = await repositories.ingestion.lastDataIngestedAt(source.sourceId);
      const stopAfterMinutes = source.intervalMinutes * settings.stopAfterIntervals;
      if (
        lastDataAt === null ||
        now.getTime() - lastDataAt.getTime() <= stopAfterMinutes * MS_PER_MINUTE
      ) {
        continue;
      }
      try {
        await deps.notifications.notifyIngestionFailure({
          sourceId: source.sourceId,
          sourceName: sourceDisplayName(source.sourceId),
          reason: `${String(stopAfterMinutes)}分以上、新しいデータが届いていません。ロボット・センサーとファイルの出力を確認してください`,
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

  async function runSourceUnlocked(source: IngestionSource): Promise<IngestionRunSummary> {
    const startedAt = clock.now();
    const profile = profiles.get(source.profileId);
    if (profile === undefined) {
      throw new AppError('INTERNAL_ERROR', '取り込みの設定に誤りがあります');
    }

    const listing = await listFilesWithRetry(source.sourceId);
    if (!listing.ok) {
      return handleListingFailure(source, profile, startedAt, listing);
    }

    const equipmentByExternalId = await loadEquipmentByExternalId(source);
    const statusCodes = await loadStatusCodes();

    // ファイルは、一覧の順に1つずつ処理する（並列にしない。保存・ログの順序を保つ）
    const outcomes: (FileOutcome | null)[] = [];
    try {
      for (const file of listing.files) {
        outcomes.push(await processFile(source, profile, file, equipmentByExternalId, statusCodes));
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
      });
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
    await writeLog(source, profile, startedAt, {
      ...summary,
      ...(failedFiles > 0
        ? { errorMessage: `${String(failedFiles)}件のファイルを取り込めませんでした` }
        : {}),
    });
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

  async function runSource(sourceId: string): Promise<IngestionRunSummary> {
    const source = await findSource(sourceId);
    if (running.has(sourceId)) {
      throw new AppError('CONFLICT', '取り込みを実行中です');
    }
    running.add(sourceId);
    try {
      return await runSourceUnlocked(source);
    } finally {
      running.delete(sourceId);
    }
  }

  return {
    runSource,

    isRunning: (sourceId) => running.has(sourceId),

    async runDueSources() {
      const now = clock.now();
      const summaries: IngestionRunSummary[] = [];
      const failures: unknown[] = [];
      for (const source of await ingestionSettings.listSources()) {
        if (!source.isEnabled || running.has(source.sourceId)) {
          continue;
        }
        const lastStartedAt = await repositories.ingestion.lastStartedAt(source.sourceId);
        const isDue =
          lastStartedAt === null ||
          now.getTime() - lastStartedAt.getTime() >= source.intervalMinutes * MS_PER_MINUTE;
        if (isDue) {
          // 取り込み元ごとに独立して実行する。想定外のエラーで1つが失敗しても、他の取り込み元は実行する
          try {
            summaries.push(await runSource(source.sourceId));
          } catch (error) {
            logger.error('取り込みに失敗しました', {
              sourceId: source.sourceId,
              ...errorLogFields(error),
            });
            failures.push(error);
          }
        }
      }
      // 新しいデータが届かなくなった取り込み元を通知する（取り込みの失敗の有無にかかわらず判定する）
      await notifyStoppedSources(clock.now());
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
      } catch {
        return {
          ok: false,
          message: '接続できませんでした。接続先と認証情報の設定を確認してください',
        };
      }
    },
  };
}

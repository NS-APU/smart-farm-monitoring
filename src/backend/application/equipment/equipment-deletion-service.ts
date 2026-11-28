/**
 * 設備の削除（D-28。Issue #229）: 設備のデータを、ジョブ（JB-05）で削除する。
 *
 * - 削除するもの: 設備の観測値（自動・手動）・手動入力と、その個別の変更履歴・評価結果・ステータスの変化の履歴・設備ごとの最終の取り込みと
 *   ファイルの取り込み済みの記録・送信していない連携項目・設備ごとの認証情報。ハウスは、配下のロボット・センサーも、ハウスの閲覧の割り当ても。
 * - 残すもの: 設備の変更履歴（登録・変更・削除）・通知・取り込みログ・連携ログ。農業情報基盤に送信済みのデータは、削除しない（範囲外）。
 * - 削除が終わるまで、設備の記録は、削除済み（isDeleted）で残り、画面・評価・取り込みの対象から外れる。この要求の記録が、進行（削除中・失敗）を持つ。
 * - 実行中の取り込み・評価が、削除のあとに書き込むことがあるため、一度削除したあと、ジョブの 1 回の実行の最長の時間（ロックの期限）だけ待って、
 *   もう一度削除し（掃除）、そのあとで、設備の記録を消す。
 * - 削除は冪等で、途中で止まっても（時間の上限・失敗）、次の実行で、続きから削除する。失敗は、エラーの種類の名前だけを記録する。
 */

import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { errorLogFields } from '../error-fields.ts';
import { JOB_LEASE_MS } from '../jobs/job-schedule.ts';
import type { AuditService } from '../audit/audit-service.ts';
import { fileServerEquipmentSecretReference } from '../ingestion/file-server-credentials.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { EquipmentDeletion, EquipmentDeletionTarget } from '../ports/records.ts';
import type { Repositories } from '../ports/repositories.ts';
import type { SecretPort } from '../ports/secret-port.ts';

/** 1 回の実行で、削除に使う時間の上限（ミリ秒）。ジョブの Lambda のタイムアウト（300 秒）の手前で、区切る。 */
const DEFAULT_BUDGET_MS = 240_000;

/** 削除中の設備の一覧の 1 件（画面の「削除中」の表示）。 */
export interface EquipmentDeletionListItem {
  readonly equipmentId: EquipmentId;
  readonly name: string;
  readonly equipmentType: string;
  /** ハウスを削除するときの、配下の設備の名前。 */
  readonly childNames: readonly string[];
  readonly requestedAt: string;
  /** 削除中（DELETING）。失敗して、次の実行で再試行するのを待っている（FAILED）。 */
  readonly status: 'DELETING' | 'FAILED';
}

export interface EquipmentDeletionRunSummary {
  /** 実行した（削除を進めた）要求の数。 */
  readonly processed: number;
  /** 設備の記録まで消えて、完了した要求の数。 */
  readonly finalized: number;
  readonly failed: number;
}

export interface EquipmentDeletionService {
  /** 削除の要求を記録する（設備は、呼び出し側が、削除済みにしてから）。 */
  request(target: Equipment, children: readonly Equipment[], requestedBy: UserId): Promise<void>;
  /** 削除中の設備の一覧（新しい要求を、あとに）。 */
  list(): Promise<EquipmentDeletionListItem[]>;
  /** その設備 ID が、削除中（データの削除が終わっていない）か。 */
  isDeleting(equipmentId: string): Promise<boolean>;
  /** ジョブ（JB-05）の 1 回の実行。 */
  run(): Promise<EquipmentDeletionRunSummary>;
}

export interface EquipmentDeletionServiceDeps {
  readonly repositories: Pick<
    Repositories,
    | 'equipment'
    | 'equipmentDeletions'
    | 'observations'
    | 'manualEntries'
    | 'evaluations'
    | 'ingestion'
    | 'federation'
    | 'auditLogs'
    | 'facilityAccess'
  >;
  /** 設備ごとの認証情報の削除に使う。 */
  readonly secrets: Pick<SecretPort, 'delete'>;
  /** 取り込み元（種別ごとの識別子）。ファイルの取り込み済みの記録の削除に使う。 */
  readonly listSources: () => Promise<readonly { sourceId: string; kind: string }[]>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly clock: ClockPort;
  readonly logger: Logger;
  /** 1 回の実行の時間の上限（ミリ秒）。テストで、変える。 */
  readonly budgetMs?: number;
  /** 掃除までの待ち（ミリ秒）。既定は、ジョブのロックの期限。テストで、変える。 */
  readonly sweepDelayMs?: number;
}

const MANUAL_ENTRY_TARGET_TYPE = 'manual-entry';

/** 失敗の記録（直近のエラーの種類）を除いた、削除の要求。 */
function withoutLastError(deletion: EquipmentDeletion): EquipmentDeletion {
  const copy = { ...deletion };
  delete copy.lastError;
  return copy;
}

function targetOf(equipment: Equipment): EquipmentDeletionTarget {
  return {
    equipmentId: equipment.equipmentId,
    name: equipment.name,
    equipmentType: equipment.equipmentType,
    ...(equipment.sourceFilePath === undefined ? {} : { sourceFilePath: equipment.sourceFilePath }),
    ...(equipment.facilityId === undefined ? {} : { facilityId: equipment.facilityId }),
  };
}

export function createEquipmentDeletionService(
  deps: EquipmentDeletionServiceDeps,
): EquipmentDeletionService {
  const { repositories, clock, logger } = deps;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const sweepDelayMs = deps.sweepDelayMs ?? JOB_LEASE_MS;

  /** 設備 1 件のデータを、すべて削除する。時間の上限で止まったら、false（続きは、次の実行）。件数は、累計に足す。 */
  async function purgeTarget(
    target: EquipmentDeletionTarget,
    deleted: EquipmentDeletion['deleted'],
    sourceIds: ReadonlyMap<string, string>,
    shouldStop: () => boolean,
  ): Promise<{ completed: boolean; deleted: EquipmentDeletion['deleted'] }> {
    const { equipmentId } = target;
    const observations = await repositories.observations.deleteByEquipment(equipmentId, {
      shouldStop,
    });
    const afterObservations = {
      ...deleted,
      observations: deleted.observations + observations.deleted,
    };
    if (!observations.completed) {
      return { completed: false, deleted: afterObservations };
    }
    // 手動入力と、その個別の変更履歴（変更履歴は、入力の ID で、探して削除する）
    const entryIds = await repositories.manualEntries.deleteByEquipment(equipmentId);
    await repositories.auditLogs.deleteByTargets(MANUAL_ENTRY_TARGET_TYPE, entryIds);
    await repositories.evaluations.deleteByEquipment(equipmentId);
    const sourceId = sourceIds.get(target.equipmentType);
    await repositories.ingestion.deleteEquipmentRecords(
      equipmentId,
      sourceId !== undefined && target.sourceFilePath !== undefined
        ? { sourceId, fileId: target.sourceFilePath }
        : undefined,
    );
    const discarded = await repositories.federation.discardUnsentByEquipment(equipmentId);
    // 設備ごとの認証情報（保管先に、なければ、何もしない）
    await deps.secrets.delete(fileServerEquipmentSecretReference(equipmentId));
    if (target.equipmentType === 'FACILITY') {
      await repositories.facilityAccess.delete(equipmentId);
    }
    return {
      completed: true,
      deleted: {
        observations: afterObservations.observations,
        manualEntries: deleted.manualEntries + entryIds.length,
        unsentFederationItems: deleted.unsentFederationItems + discarded,
      },
    };
  }

  /** 要求 1 件を進める。完了（設備の記録まで消えた）なら、true。 */
  async function advance(
    deletion: EquipmentDeletion,
    sourceIds: ReadonlyMap<string, string>,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    let deleted = deletion.deleted;
    for (const target of deletion.targets) {
      const result = await purgeTarget(target, deleted, sourceIds, shouldStop);
      deleted = result.deleted;
      if (!result.completed) {
        // 時間の上限で止まった。ここまでの件数を記録し、次の実行で、続きから削除する
        await repositories.equipmentDeletions.save({
          ...deletion,
          deleted,
          attempts: deletion.attempts + 1,
          lastAttemptAt: clock.now().toISOString(),
        });
        return false;
      }
    }
    if (deletion.phase === 'PURGING') {
      // 削除が終わった。失敗の記録は、消す
      await repositories.equipmentDeletions.save({
        ...withoutLastError(deletion),
        phase: 'SWEEPING',
        sweepAfter: new Date(clock.now().getTime() + sweepDelayMs).toISOString(),
        deleted,
        attempts: deletion.attempts + 1,
        lastAttemptAt: clock.now().toISOString(),
      });
      return false;
    }
    // 掃除のあと: 設備の記録を消し、要求を消して、削除の記録（件数）を、変更履歴に残す
    for (const target of deletion.targets) {
      await repositories.equipment.delete(target.equipmentId);
    }
    await repositories.equipmentDeletions.delete(deletion.equipmentId);
    await deps.audit.record({
      operation: 'DELETE',
      targetType: 'equipment',
      targetId: deletion.equipmentId,
      actor: deletion.requestedBy,
      before: {
        equipmentIds: deletion.targets.map((target) => target.equipmentId),
        deleted,
      },
    });
    logger.info('設備のデータを削除しました', {
      equipmentId: deletion.equipmentId,
      targets: deletion.targets.length,
      ...deleted,
    });
    return true;
  }

  return {
    async request(target, children, requestedBy) {
      await repositories.equipmentDeletions.save({
        equipmentId: target.equipmentId,
        targets: [target, ...children].map(targetOf),
        requestedBy,
        requestedAt: clock.now().toISOString(),
        phase: 'PURGING',
        attempts: 0,
        deleted: { observations: 0, manualEntries: 0, unsentFederationItems: 0 },
      });
    },

    async isDeleting(equipmentId) {
      return (await repositories.equipmentDeletions.list()).some((deletion) =>
        deletion.targets.some((target) => target.equipmentId === equipmentId),
      );
    },

    async list() {
      return (await repositories.equipmentDeletions.list())
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
        .map((deletion) => {
          const [head, ...rest] = deletion.targets;
          return {
            equipmentId: deletion.equipmentId,
            name: head?.name ?? deletion.equipmentId,
            equipmentType: head?.equipmentType ?? '',
            childNames: rest.map((target) => target.name),
            requestedAt: deletion.requestedAt,
            status: deletion.lastError === undefined ? ('DELETING' as const) : ('FAILED' as const),
          };
        });
    },

    async run() {
      const deadline = clock.now().getTime() + budgetMs;
      const shouldStop = (): boolean => clock.now().getTime() >= deadline;
      const sourceIds = new Map(
        (await deps.listSources()).map((source) => [source.kind, source.sourceId] as const),
      );
      let processed = 0;
      let finalized = 0;
      let failed = 0;
      for (const deletion of await repositories.equipmentDeletions.list()) {
        // 掃除の待ちの間は、何もしない
        if (
          deletion.phase === 'SWEEPING' &&
          deletion.sweepAfter !== undefined &&
          Date.parse(deletion.sweepAfter) > clock.now().getTime()
        ) {
          continue;
        }
        processed += 1;
        try {
          if (await advance(deletion, sourceIds, shouldStop)) {
            finalized += 1;
          }
        } catch (error) {
          failed += 1;
          const fields = errorLogFields(error);
          logger.error('設備のデータの削除に失敗しました', {
            equipmentId: deletion.equipmentId,
            ...fields,
          });
          await repositories.equipmentDeletions.save({
            ...deletion,
            attempts: deletion.attempts + 1,
            lastError: error instanceof Error ? error.name : 'UnknownError',
            lastAttemptAt: clock.now().toISOString(),
          });
        }
        if (shouldStop()) {
          break;
        }
      }
      return { processed, finalized, failed };
    },
  };
}

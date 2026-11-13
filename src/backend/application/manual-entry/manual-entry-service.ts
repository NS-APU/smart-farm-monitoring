/**
 * 手動入力のユースケース（UC-06、UC-07、UC-18。FR-4.1、FR-4.2）。
 * 入力 → 検証 → 保存（1回の入力と、項目ごとの観測値）→ 変更履歴 → 評価の更新（→ 通知）。
 * 修正・削除は、論理削除を基本とし、観測値も削除済みにして、集計の対象から外す。
 * 修正・削除の後も、保存後と同じく評価を更新する（暫定。dev_spec.md 4章 No.21）。
 */

import {
  CATEGORY_LABELS,
  STATUS_CODE_ITEM_KEY,
  findItemDefinition,
  type Category,
} from '@smart-farm/shared/constants/items';
import type { ManualEntrySortKey, SortDirection } from '@smart-farm/shared/constants/sorting';
import {
  VIEWPOINT_IDS,
  defaultPeriodDays,
  findViewpointMeta,
} from '@smart-farm/shared/constants/viewpoints';
import { AppError, validationError } from '@smart-farm/shared/errors';
import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import {
  validateManualEntry,
  type ManualEntry,
  type ManualEntryInput,
  type ManualEntryListResponse,
  type ManualEntrySaveResponse,
  type ManualEntryViewpointStatus,
} from '@smart-farm/shared/schemas/manual-entry';
import type { Observation } from '@smart-farm/shared/schemas/observation';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import { combineHorizonStatuses } from '../../domain/evaluation/grading.ts';
import { getViewpointDefinition } from '../../domain/evaluation/viewpoints/registry.ts';
import { viewpointSourceItemKeys } from '../../domain/evaluation/viewpoints/source-items.ts';
import type { AuditService } from '../audit/audit-service.ts';
import { ALL_EQUIPMENT, canViewEquipment, type EquipmentScope } from '../access/facility-scope.ts';
import {
  EQUIPMENT_NOT_FOUND_MESSAGE,
  requireActiveEquipment,
} from '../equipment/require-active-equipment.ts';
import type { EvaluationService } from '../evaluation/evaluation-service.ts';
import type { EvaluationOnWrite } from '../evaluation/evaluation-on-write.ts';
import { reevaluateSafely } from '../evaluation/reevaluate-safely.ts';
import type { FederationService } from '../federation/federation-service.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { IdGeneratorPort } from '../ports/id-generator-port.ts';
import type { Logger } from '../ports/logger-port.ts';
import type { Repositories } from '../ports/repositories.ts';

const MANUAL_ENTRY_TARGET_TYPE = 'manual-entry' satisfies AuditTargetType;

export interface ManualEntryListQuery {
  readonly keyword?: string | undefined;
  readonly category?: Category | undefined;
  readonly equipmentId?: EquipmentId | undefined;
  /** 閲覧範囲（省略は全設備。Issue #330）。 */
  readonly scope?: EquipmentScope | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly sort: ManualEntrySortKey;
  readonly direction: SortDirection;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/**
 * 閲覧範囲（`scope`。省略は全設備。Issue #330）: 範囲外の設備への登録・範囲外の設備の入力の修正・削除・範囲外の設備への付け替えは、存在しないもの（NOT_FOUND）。
 * 一覧は、範囲内の設備の入力だけ。範囲内の入力は、他人の入力にも、修正・削除できる（ADR-0013）。
 */
export interface ManualEntryService {
  create(
    input: ManualEntryInput,
    actor: UserId,
    scope?: EquipmentScope,
  ): Promise<ManualEntrySaveResponse>;
  update(
    entryId: string,
    input: ManualEntryInput,
    actor: UserId,
    scope?: EquipmentScope,
  ): Promise<ManualEntrySaveResponse>;
  /** 論理削除する。存在しない（削除済みを含む）場合は NOT_FOUND。 */
  delete(entryId: string, actor: UserId, scope?: EquipmentScope): Promise<void>;
  list(query: ManualEntryListQuery): Promise<ManualEntryListResponse>;
}

export interface ManualEntryServiceDeps {
  readonly repositories: Pick<
    Repositories,
    'manualEntries' | 'observations' | 'equipment' | 'evaluations' | 'statusCodes'
  >;
  readonly audit: AuditService;
  readonly evaluation: EvaluationService;
  /** 保存・修正・削除の応答の前に、評価を再計算するか（ADR-0014）。 */
  readonly evaluationOnWrite: EvaluationOnWrite;
  readonly federation: FederationService;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly logger: Logger;
}

/** 手動入力の値の文字列（キーワード検索の対象。単位つき・なしの両方。文字列の値〔ステータスコード〕は、その文字列）。 */
function valueTexts(itemKey: string, value: number | string): string[] {
  const item = findItemDefinition(itemKey);
  return [String(value), `${String(value)}${item?.unit ?? ''}`, item?.label ?? itemKey];
}

function toObservations(entry: ManualEntry, isDeleted: boolean): Observation[] {
  return Object.entries(entry.items).map(([itemKey, value]) => ({
    equipmentId: entry.equipmentId,
    category: entry.category,
    itemKey,
    observedAt: entry.observedAt,
    value,
    source: 'MANUAL',
    quality: 'VALID',
    receivedAt: entry.updatedAt,
    enteredBy: entry.enteredBy,
    ...(entry.note === undefined || entry.note === '' ? {} : { note: entry.note }),
    manualEntryId: entry.entryId,
    isDeleted,
  }));
}

/** キーワード（小文字）が、入力の設備名・カテゴリ・入力者・備考・各項目の値の表示のいずれかに含まれるか。 */
function entryMatchesKeyword(
  entry: ManualEntry,
  keyword: string,
  equipmentNames: ReadonlyMap<string, string>,
): boolean {
  return [
    equipmentNames.get(entry.equipmentId) ?? entry.equipmentId,
    CATEGORY_LABELS[entry.category],
    entry.enteredBy,
    entry.note ?? '',
    ...Object.entries(entry.items).flatMap(([itemKey, value]) => valueTexts(itemKey, value)),
  ].some((text) => text.toLowerCase().includes(keyword));
}

export function createManualEntryService(deps: ManualEntryServiceDeps): ManualEntryService {
  const { repositories, audit, evaluation, evaluationOnWrite, federation, clock, ids, logger } =
    deps;
  /** 応答に付ける、評価の状態。`deferred` では、評価は、定期の評価（JB-02）が更新する。 */
  const evaluationState = evaluationOnWrite === 'sync' ? 'DONE' : 'DEFERRED';

  const findActiveEquipment = (equipmentId: EquipmentId): Promise<Equipment> =>
    requireActiveEquipment(repositories.equipment, equipmentId);

  async function assertValid(input: ManualEntryInput): Promise<void> {
    const fields = validateManualEntry({ ...input, note: input.note ?? '' }, clock.now());
    // ステータスコードは、登録済み（削除していない）のコードだけ（#192）。値の形の誤りは、上で検出済み
    const statusCode = input.items[STATUS_CODE_ITEM_KEY];
    if (
      typeof statusCode === 'string' &&
      !fields.some((field) => field.name === `items.${STATUS_CODE_ITEM_KEY}`)
    ) {
      const definition = await repositories.statusCodes.get(statusCode);
      if (definition === undefined || definition.isDeleted) {
        fields.push({
          name: `items.${STATUS_CODE_ITEM_KEY}`,
          message: 'ステータスコードは、登録済み（削除していない）のコードから選択してください',
        });
      }
    }
    if (fields.length > 0) {
      throw validationError(fields);
    }
  }

  /** 同じ設備・項目・計測日時の手動入力は、1つだけ（取得元が同じ観測値の一意キー）。 */
  async function assertNoConflict(input: ManualEntryInput, ownEntryId: string): Promise<void> {
    // 計測日時の表記（入力のままと、ミリ秒つきの標準の形）の両方で、一意キーを直接引く（設備の全観測値を走査しない）
    const observedAtForms = [
      ...new Set([input.observedAt, new Date(input.observedAt).toISOString()]),
    ];
    const conflicts: { name: string; message: string }[] = [];
    for (const itemKey of Object.keys(input.items)) {
      const found = await Promise.all(
        observedAtForms.map((observedAt) =>
          repositories.observations.findByKey(input.equipmentId, itemKey, observedAt, 'MANUAL'),
        ),
      );
      if (
        found.some(
          (observation) =>
            observation !== undefined &&
            !observation.isDeleted &&
            observation.manualEntryId !== ownEntryId,
        )
      ) {
        conflicts.push({
          name: `items.${itemKey}`,
          message:
            '同じ設備・項目・計測日時の入力がすでにあります。入力済みデータを修正してください',
        });
      }
    }
    if (conflicts.length > 0) {
      throw new AppError('CONFLICT', '同じ計測日時の入力がすでにあります', { fields: conflicts });
    }
  }

  /** 手動入力のデータ（生データ）を、農業情報基盤への連携キューに積む（FR-8.1）。削除は、削除済みの観測値として送る。 */
  async function enqueueFederation(entry: ManualEntry, observations: Observation[]): Promise<void> {
    await federation.enqueue({
      targetType: 'OBSERVATION',
      targetRef: `manual-entry#${entry.entryId}`,
      payload: { entryId: entry.entryId, observations },
    });
  }

  /**
   * 評価の更新。失敗しても、入力の保存の結果には影響させない。
   * `deferred` では、何もしない（データが増えると、評価の読み出しで、応答が遅くなるため。定期の評価が更新する。ADR-0014）。
   */
  const reevaluate = (affected: readonly EquipmentId[]): Promise<void> =>
    evaluationOnWrite === 'deferred'
      ? Promise.resolve()
      : reevaluateSafely(
          evaluation,
          logger,
          'MANUAL_ENTRY',
          '手動入力の後の評価に失敗しました',
          affected,
        );

  /** 入力した項目に関係する観点の、最新のステータス（ハウス単位。短期・長期の悪い方）。 */
  async function relatedStatuses(entry: ManualEntry): Promise<ManualEntryViewpointStatus[]> {
    const equipment = await repositories.equipment.get(entry.equipmentId);
    const facilityId = equipment?.facilityId ?? entry.equipmentId;
    const itemKeys = Object.keys(entry.items);
    // 観点ごとの、最新の結果の読み出しは、互いに独立のため、並列に行う（観点の順は、保つ。Issue #79）
    const found = await Promise.all(
      VIEWPOINT_IDS.map(async (viewpointId): Promise<ManualEntryViewpointStatus | undefined> => {
        const definition = getViewpointDefinition(viewpointId);
        const sourceKeys = viewpointSourceItemKeys(definition);
        if (sourceKeys !== null && !sourceKeys.some((key) => itemKeys.includes(key))) {
          return undefined;
        }
        const [long, short] = await Promise.all([
          repositories.evaluations.getLatest(
            facilityId,
            viewpointId,
            'LONG',
            defaultPeriodDays(viewpointId),
          ),
          definition.hasShortHorizon
            ? repositories.evaluations.getLatest(facilityId, viewpointId, 'SHORT', null)
            : Promise.resolve(undefined),
        ]);
        if (long === undefined) {
          return undefined;
        }
        return {
          viewpointId,
          name: findViewpointMeta(viewpointId)?.name ?? viewpointId,
          status: combineHorizonStatuses(short?.status ?? null, long.status),
        };
      }),
    );
    return found.filter((status): status is ManualEntryViewpointStatus => status !== undefined);
  }

  async function findEntry(entryId: string, scope: EquipmentScope): Promise<ManualEntry> {
    const entry = await repositories.manualEntries.get(entryId);
    // 範囲外の設備の入力は、存在しないものとして扱う（設備の有無を、漏らさない）
    if (entry === undefined || entry.isDeleted || !canViewEquipment(scope, entry.equipmentId)) {
      throw new AppError('NOT_FOUND', '入力データが見つかりません');
    }
    return entry;
  }

  /** 閲覧範囲の設備か（範囲外は、存在しないもの）。 */
  function assertInScope(scope: EquipmentScope, equipmentId: EquipmentId): void {
    if (!canViewEquipment(scope, equipmentId)) {
      throw new AppError('NOT_FOUND', EQUIPMENT_NOT_FOUND_MESSAGE);
    }
  }

  return {
    async create(input, actor, scope = ALL_EQUIPMENT) {
      await assertValid(input);
      assertInScope(scope, input.equipmentId);
      await findActiveEquipment(input.equipmentId);
      const entryId = ids.next();
      await assertNoConflict(input, entryId);

      const now = clock.now().toISOString();
      const entry: ManualEntry = {
        ...input,
        entryId,
        enteredBy: actor,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      };
      const observations = toObservations(entry, false);
      await repositories.manualEntries.save(entry);
      await repositories.observations.saveMany(observations);
      await enqueueFederation(entry, observations);
      await audit.record({
        operation: 'CREATE',
        targetType: MANUAL_ENTRY_TARGET_TYPE,
        targetId: entryId,
        actor,
        after: entry,
      });
      await reevaluate([entry.equipmentId]);
      return {
        entry,
        viewpointStatuses: await relatedStatuses(entry),
        evaluation: evaluationState,
      };
    },

    async update(entryId, input, actor, scope = ALL_EQUIPMENT) {
      const before = await findEntry(entryId, scope);
      await assertValid(input);
      assertInScope(scope, input.equipmentId);
      await findActiveEquipment(input.equipmentId);
      await assertNoConflict(input, entryId);

      const entry: ManualEntry = {
        ...input,
        entryId,
        enteredBy: before.enteredBy,
        createdAt: before.createdAt,
        updatedAt: clock.now().toISOString(),
        isDeleted: false,
      };
      // 修正前の観測値は削除済みにしてから、修正後の観測値を保存する（同じキーは、後者が残る）
      const observations = [...toObservations(before, true), ...toObservations(entry, false)];
      await repositories.observations.saveMany(observations);
      await repositories.manualEntries.save(entry);
      await enqueueFederation(entry, observations);
      await audit.record({
        operation: 'UPDATE',
        targetType: MANUAL_ENTRY_TARGET_TYPE,
        targetId: entryId,
        actor,
        before,
        after: entry,
      });
      // 設備を変更した修正は、変更前の設備も評価し直す
      await reevaluate([before.equipmentId, entry.equipmentId]);
      return {
        entry,
        viewpointStatuses: await relatedStatuses(entry),
        evaluation: evaluationState,
      };
    },

    async delete(entryId, actor, scope = ALL_EQUIPMENT) {
      const before = await findEntry(entryId, scope);
      const deleted: ManualEntry = {
        ...before,
        isDeleted: true,
        updatedAt: clock.now().toISOString(),
      };
      const observations = toObservations(before, true);
      await repositories.manualEntries.save(deleted);
      await repositories.observations.saveMany(observations);
      await enqueueFederation(deleted, observations);
      await audit.record({
        operation: 'DELETE',
        targetType: MANUAL_ENTRY_TARGET_TYPE,
        targetId: entryId,
        actor,
        before,
      });
      await reevaluate([before.equipmentId]);
    },

    async list(query) {
      const scope = query.scope ?? ALL_EQUIPMENT;
      if (query.equipmentId !== undefined) {
        assertInScope(scope, query.equipmentId);
      }
      const equipmentNames = new Map(
        (await repositories.equipment.list({ includeDeleted: true })).map((equipment) => [
          equipment.equipmentId,
          equipment.name,
        ]),
      );
      const keyword = query.keyword?.trim().toLowerCase() ?? '';
      const page = await repositories.manualEntries.list(
        {
          ...omitUndefined({
            category: query.category,
            equipmentId: query.equipmentId,
            from: query.from,
            to: query.to,
          }),
          ...(keyword === '' && scope.kind === 'all'
            ? {}
            : {
                matches: (entry: ManualEntry) =>
                  canViewEquipment(scope, entry.equipmentId) &&
                  (keyword === '' || entryMatchesKeyword(entry, keyword, equipmentNames)),
              }),
        },
        { limit: query.limit, cursor: query.cursor },
        { key: query.sort, direction: query.direction },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    },
  };
}

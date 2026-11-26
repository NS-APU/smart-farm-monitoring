/**
 * 以前の論理削除済みの設備を、削除の要求に移すコマンド（`pnpm migrate-deleted-equipment`。Issue #229。ADR-0018 の D-28）。
 * 以前は、設備を削除しても、設備の記録・観測値などが残った（論理削除）。設備を削除すると、設備のデータを削除する仕様に変えたため、
 * 削除済みで残っている設備も、削除のジョブ（JB-05）が、データを削除し、設備の記録を消せるように、削除の要求にする。
 * これをしないと、削除済みの設備の ID は、再登録できない（設備の記録が残るため）。
 *
 * - 削除済みの設備のうち、削除の要求にまだなっていないものを、削除の要求にする。ハウスは、削除済みの配下と、1 件にまとめる。
 *   ハウスが登録中の、削除済みのロボット・センサーは、単独で 1 件にする
 * - 設備の記録・データには、触れない（削除は、ジョブが行う。削除したデータは、元に戻せない。誤りに気づいたときは、PITR で取り出す）
 * - 何度実行しても同じ（対象がなければ、何もしない）。途中で失敗しても、再実行できる
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあり、チャット・Issue・PR に貼らないため。security.md）。
 *   設備の ID・名前は、出力しない（件数だけを示す）
 *
 * 環境変数: AWS では、Lambda と同じ PERSISTENCE=dynamodb・DYNAMODB_*_TABLE。AWS_REGION の既定は ap-northeast-1。
 * ローカルの開発（PERSISTENCE=file）では、DATA_FILE（既定は `.local-data/store.json`）の設備を移す。
 * - MIGRATE_DRY_RUN: `true` なら、件数を示すだけで、書き込まない
 */

import { AppError } from '@smart-farm/shared/errors';
import { toUserId } from '@smart-farm/shared/schemas/common';
import type { Equipment } from '@smart-farm/shared/schemas/equipment';
import { ConfigError, parseConfig } from './config.ts';
import type { CommandOutput } from './initial-user-cli.ts';
import { createContainer, type Container } from './container.ts';

const DEFAULT_REGION = 'ap-northeast-1';
/** 削除の要求の、依頼者（利用者の操作ではなく、移行コマンドが作ったことを示す）。 */
const MIGRATION_ACTOR = toUserId('migration');

type Env = Readonly<Record<string, string | undefined>>;

export interface MigrateDeletedEquipmentDeps {
  /** コンテナの組み立て（テストで、失敗を差し込む）。 */
  readonly createContainer?: typeof createContainer;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・テーブル名の設定を確認してください`;
}

/** 削除済みの設備を、削除の要求の単位（ハウスと削除済みの配下、または、単独の設備）に分ける。 */
function groupDeleted(
  all: readonly Equipment[],
  covered: ReadonlySet<string>,
): { target: Equipment; children: Equipment[] }[] {
  const deleted = all.filter((item) => item.isDeleted && !covered.has(item.equipmentId));
  const facilities = deleted.filter((item) => item.equipmentType === 'FACILITY');
  const facilityIds = new Set(facilities.map((item) => item.equipmentId));
  return [
    ...facilities.map((facility) => ({
      target: facility,
      children: deleted.filter((item) => item.facilityId === facility.equipmentId),
    })),
    // ハウスが、削除済みでない（または、すでに要求になっている）削除済みの設備は、単独で
    ...deleted
      .filter(
        (item) =>
          item.equipmentType !== 'FACILITY' &&
          (item.facilityId === undefined || !facilityIds.has(item.facilityId)),
      )
      .map((item) => ({ target: item, children: [] })),
  ];
}

export async function runMigrateDeletedEquipmentCli(
  env: Env,
  output: CommandOutput,
  deps: MigrateDeletedEquipmentDeps = {},
): Promise<number> {
  try {
    const config = parseConfig({ AWS_REGION: DEFAULT_REGION, ...env });
    if (config.persistence === 'memory') {
      throw new ConfigError(
        'PERSISTENCE=dynamodb または file の設定が必要です（メモリには、移す対象が残りません）',
      );
    }
    const dryRun = env.MIGRATE_DRY_RUN === 'true';

    const container: Container = (deps.createContainer ?? createContainer)(config);
    try {
      const { repositories } = container;
      const all = await repositories.equipment.list({ includeDeleted: true });
      const requests = await repositories.equipmentDeletions.list();
      const covered = new Set(
        requests.flatMap((request) => request.targets.map((target) => target.equipmentId)),
      );
      const groups = groupDeleted(all, covered);
      const equipmentCount = groups.reduce((total, group) => total + 1 + group.children.length, 0);
      if (groups.length === 0) {
        output.info('削除の要求にする設備は、ありませんでした。何もしませんでした');
      } else if (dryRun) {
        output.info(
          `削除済みの設備 ${String(equipmentCount)} 件を、削除の要求 ${String(groups.length)} 件にします（MIGRATE_DRY_RUN=true のため、書き込んでいません）`,
        );
      } else {
        for (const group of groups) {
          // 削除済みの配下は、ハウスの要求に含める。要求の記録は、削除のサービスと同じ形にする
          await container.equipmentDeletionService.request(
            group.target,
            group.children,
            MIGRATION_ACTOR,
          );
        }
        output.info(
          `削除済みの設備 ${String(equipmentCount)} 件を、削除の要求 ${String(groups.length)} 件にしました`,
        );
      }
    } finally {
      container.close();
    }
    return 0;
  } catch (error) {
    output.error(`削除の要求に移せませんでした: ${describeFailure(error)}`);
    return 1;
  }
}

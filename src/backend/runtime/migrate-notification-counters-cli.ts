/**
 * 既存の通知の移行コマンド（`pnpm migrate-notification-counters`。Issue #331。ADR-0013・ADR-0019 の D-41）。
 * 通知を、閲覧できる利用者にだけ表示・配信するため、通知に、閲覧範囲のハウス（`facilityId`）と、ハウスごとのカウンター
 * （通知の総数・利用者ごとの既読数）を持たせた。それ以前の通知には、どちらもないため、このコマンドで補う。
 * 移行の前は、ハウスの情報がない通知は、一般ユーザーには見えず、一般ユーザーの未読の件数は、低く出る（安全側）。
 * 新しい版を AWS にデプロイしたあとに、利用者（運用者）が、AWS のプロファイルを指定して、手元で実行する。
 *
 * - 通知の記録に、ハウスを補う（状態変化の通知は、設備のハウス。ハウス自身は、その ID）。取り込みの失敗・取得停止・連携の期限切れ
 *   （ハウスに属さない通知）と、設備が見つからない通知は、補わない（全設備を閲覧できる利用者だけが、見える）
 * - ハウスごとのカウンターを、通知・既読の記録から、絶対値で再集計する。何度実行しても同じ。途中で失敗しても、再実行できる
 * - 実行の間に作られた通知・既読が、カウンターに反映されないことがある（短時間。再実行で直る）
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあるため。security.md）。通知の内容は、出力しない
 *
 * 環境変数: AWS では、Lambda と同じ PERSISTENCE=dynamodb・DYNAMODB_*_TABLE（値は、SfmData のスタックの出力）。AWS_REGION の既定は ap-northeast-1。
 * ローカルの開発（PERSISTENCE=file）では、DATA_FILE の通知に、ハウスを補う（カウンターは、持たない）。
 * - MIGRATE_DRY_RUN: `true` なら、件数を示すだけで、書き込まない
 */

import { AppError } from '@smart-farm/shared/errors';
import type { EquipmentId } from '@smart-farm/shared/schemas/common';
import { ConfigError, parseConfig } from './config.ts';
import { createContainer, type Container } from './container.ts';
import type { CommandOutput } from './initial-user-cli.ts';

const DEFAULT_REGION = 'ap-northeast-1';

type Env = Readonly<Record<string, string | undefined>>;

export interface MigrateNotificationCountersDeps {
  /** コンテナの組み立て（テストで、失敗を差し込む）。 */
  readonly createContainer?: typeof createContainer;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・テーブル名の設定を確認してください`;
}

export async function runMigrateNotificationCountersCli(
  env: Env,
  output: CommandOutput,
  deps: MigrateNotificationCountersDeps = {},
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
      const { equipment, users, notifications } = container.repositories;
      // 削除済みの設備も含める（削除済みの設備の通知にも、ハウスを補う）
      const byId = new Map(
        (await equipment.list({ includeDeleted: true })).map((item) => [item.equipmentId, item]),
      );
      const facilityOf = (notification: { equipmentId?: EquipmentId | undefined }) => {
        const found =
          notification.equipmentId === undefined ? undefined : byId.get(notification.equipmentId);
        return found === undefined ? undefined : (found.facilityId ?? found.equipmentId);
      };
      const result = await notifications.rebuildFacilityIndex({
        facilityOf,
        userIds: (await users.list()).map((user) => user.userId),
        dryRun,
      });
      const counted = config.persistence === 'dynamodb';
      if (dryRun) {
        output.info(
          `通知 ${String(result.notifications)} 件を確認しました。${String(result.assigned)} 件にハウスを補い${counted ? '、ハウスごとのカウンターを再集計します' : ''}（MIGRATE_DRY_RUN=true のため、書き込んでいません）`,
        );
      } else if (counted) {
        output.info(
          `通知 ${String(result.notifications)} 件を確認し、${String(result.assigned)} 件にハウスを補いました。ハウスごとのカウンターを、再集計しました（ハウス ${String(result.facilities)} つ・利用者 ${String(result.users)} 人）`,
        );
      } else {
        output.info(
          `通知 ${String(result.notifications)} 件を確認し、${String(result.assigned)} 件にハウスを補いました（ローカルのファイルは、カウンターを持たないため、再集計は、ありません）`,
        );
      }
    } finally {
      container.close();
    }
    return 0;
  } catch (error) {
    output.error(`通知を移行できませんでした: ${describeFailure(error)}`);
    return 1;
  }
}

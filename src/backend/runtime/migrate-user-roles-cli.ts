/**
 * 既存ユーザーのロールを移すコマンド（`pnpm migrate-user-roles`。Issue #115。ADR-0013）。
 * ロールを、「農作業者（`worker`。全権限）」の 1 種類から、「管理者（`admin`）・一般（`general`）」の 2 種類に分けたため、
 * 既存のユーザー（ロール `worker`）は、新しいロールの定義にない値になり、権限を持たなくなる（管理者も、ユーザー管理ができなくなる）。
 * このため、新しい版を AWS に適用する前に、利用者（運用者）が、AWS のプロファイルを指定して、手元で実行する。
 *
 * - DynamoDB のユーザーの記録（ロールの値）だけを書き換える。名前・作成日時・パスワード（Cognito）には、触れない
 * - 何度実行しても同じ（移す対象がなければ、何もしない）。途中で失敗しても、再実行できる
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあり、
 *   チャット・Issue・PR に貼らないため。security.md）。ユーザー ID・名前は、出力しない（人数だけを示す）
 *
 * 環境変数: AWS では、Lambda と同じ PERSISTENCE=dynamodb・DYNAMODB_*_TABLE（値は、SfmData のスタックの出力）。AWS_REGION の既定は ap-northeast-1。
 * ローカルの開発（PERSISTENCE=file）では、DATA_FILE（既定は `.local-data/store.json`）のユーザーを移す。
 * - MIGRATE_FROM_ROLE: 移す元のロール（既定は `worker`）
 * - MIGRATE_TO_ROLE: 移す先のロール（既定は `admin`。ロール定義にあるもの）
 * - MIGRATE_DRY_RUN: `true` なら、対象の人数を示すだけで、書き込まない
 */

import { AppError } from '@smart-farm/shared/errors';
import { ADMIN_ROLE_ID } from '@smart-farm/shared/constants/permissions';
import { ConfigError, parseConfig } from './config.ts';
import type { CommandOutput } from './initial-user-cli.ts';
import { createContainer, type Container } from './container.ts';

const DEFAULT_REGION = 'ap-northeast-1';
/** 移す元の既定のロール（ロールを分ける前の、全権限の 1 ロール）。 */
const LEGACY_ROLE_ID = 'worker';

type Env = Readonly<Record<string, string | undefined>>;

export interface MigrateUserRolesDeps {
  /** コンテナの組み立て（テストで、失敗を差し込む）。 */
  readonly createContainer?: typeof createContainer;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・テーブル名の設定を確認してください`;
}

export async function runMigrateUserRolesCli(
  env: Env,
  output: CommandOutput,
  deps: MigrateUserRolesDeps = {},
): Promise<number> {
  try {
    const config = parseConfig({ AWS_REGION: DEFAULT_REGION, ...env });
    if (config.persistence === 'memory') {
      throw new ConfigError(
        'PERSISTENCE=dynamodb または file の設定が必要です（メモリには、移す対象が残りません）',
      );
    }
    const from = env.MIGRATE_FROM_ROLE ?? LEGACY_ROLE_ID;
    const to = env.MIGRATE_TO_ROLE ?? ADMIN_ROLE_ID;
    if (from === to) {
      throw new ConfigError('移す元と移す先のロールが同じです');
    }
    if (!Object.hasOwn(config.roles, to)) {
      throw new ConfigError('MIGRATE_TO_ROLE が、ロール定義にありません');
    }
    const dryRun = env.MIGRATE_DRY_RUN === 'true';

    const container: Container = (deps.createContainer ?? createContainer)(config);
    try {
      const targets = (await container.repositories.users.list()).filter(
        (user) => user.role === from,
      );
      if (targets.length === 0) {
        output.info(`ロール「${from}」のユーザーは、いませんでした。何もしませんでした`);
      } else if (dryRun) {
        output.info(
          `ロール「${from}」のユーザーは、${String(targets.length)} 人います。「${to}」に移します（MIGRATE_DRY_RUN=true のため、書き込んでいません）`,
        );
      } else {
        for (const user of targets) {
          await container.repositories.users.save({ ...user, role: to });
        }
        output.info(
          `ロール「${from}」のユーザー ${String(targets.length)} 人を、「${to}」に移しました`,
        );
      }
    } finally {
      container.close();
    }
    return 0;
  } catch (error) {
    output.error(`ロールを移せませんでした: ${describeFailure(error)}`);
    return 1;
  }
}

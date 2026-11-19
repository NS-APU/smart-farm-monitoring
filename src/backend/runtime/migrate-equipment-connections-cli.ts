/**
 * 取り込み元の共通の接続を、設備ごとの接続へコピーする移行コマンド（`pnpm migrate-equipment-connections`。Issue #367。ADR-0026）。
 * 取り込みの接続を、取り込み元ごとの共通の接続から、設備ごとの接続にする。設備に自分の接続があれば、それを使い、なければ共通の接続を使う
 * （移行期間）。共通の接続を廃止する前に、既存の設備へ、共通の接続の値をコピーして、取り込みを止めないようにする。
 * 新しい版を AWS にデプロイしたあとに、利用者（運用者）が、AWS のプロファイルを指定して、手元で実行する。
 *
 * - 対象: ファイルのパス（`sourceFilePath`）を持つ、削除されていない、ロボット・センサーの設備のうち、設備ごとの接続を持たないもの。
 *   種別が同じ取り込み元の共通の接続を、コピーする（共通の接続が未設定の種別は、スキップ）
 * - 既定は、何も変えず、対象の件数を示す（ドライラン）。`--yes` で、実行する。何度実行しても同じ（コピー済みの設備は、対象にならない）。
 *   途中で失敗しても、再実行できる
 * - 認証情報は、コピーしない（設備ごとに、画面から、入力し直す。共通の認証情報は、そのまま残る）
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあり、チャット・Issue・PR に貼らないため。security.md）。
 *   出力は、件数だけ（ホスト名・設備名・接続の値は、出力しない）
 *
 * 環境変数: AWS では、Lambda と同じ PERSISTENCE=dynamodb・DYNAMODB_*_TABLE（値は、SfmData のスタックの出力）。AWS_REGION の既定は ap-northeast-1。
 * ローカルの開発（PERSISTENCE=file）では、DATA_FILE の設定に、コピーする。
 */

import { AppError } from '@smart-farm/shared/errors';
import { ConfigError, parseConfig } from './config.ts';
import { createContainer, type Container } from './container.ts';
import type { CommandOutput } from './initial-user-cli.ts';

const DEFAULT_REGION = 'ap-northeast-1';
const USAGE = '使い方: pnpm migrate-equipment-connections [--yes]';

type Env = Readonly<Record<string, string | undefined>>;

export interface MigrateEquipmentConnectionsDeps {
  /** コンテナの組み立て（テストで、失敗を差し込む）。 */
  readonly createContainer?: typeof createContainer;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・テーブル名の設定を確認してください`;
}

export async function runMigrateEquipmentConnectionsCli(
  args: readonly string[],
  env: Env,
  output: CommandOutput,
  deps: MigrateEquipmentConnectionsDeps = {},
): Promise<number> {
  try {
    if (args.some((arg) => arg !== '--yes')) {
      throw new ConfigError(`指定できない引数があります。${USAGE}`);
    }
    const confirmed = args.includes('--yes');
    const config = parseConfig({ AWS_REGION: DEFAULT_REGION, ...env });
    if (config.persistence === 'memory') {
      throw new ConfigError(
        'PERSISTENCE=dynamodb または file の設定が必要です（メモリには、移す対象が残りません）',
      );
    }
    const container: Container = (deps.createContainer ?? createContainer)(config);
    try {
      const sources = await container.ingestionSettings.listSources();
      const own = await container.equipmentConnections.list();
      // 取り込みの対象（ファイルのパスを持つ、削除されていない、ロボット・センサー）
      const equipment = (await container.repositories.equipment.list()).filter(
        (item) => item.equipmentType !== 'FACILITY' && item.sourceFilePath !== undefined,
      );
      const withOwn = equipment.filter((item) => own.has(item.equipmentId));
      const candidates = equipment.filter((item) => !own.has(item.equipmentId));
      const targets = candidates.flatMap((item) => {
        const shared = sources.find((source) => source.kind === item.equipmentType)?.connection;
        return shared === undefined ? [] : [{ equipmentId: item.equipmentId, connection: shared }];
      });
      const skipped = candidates.length - targets.length;
      const summary = `取り込みの対象の設備 ${String(equipment.length)} 件のうち、コピーする設備 ${String(targets.length)} 件・設備ごとの接続が設定済みの設備 ${String(withOwn.length)} 件・共通の接続が未設定のため、コピーしない設備 ${String(skipped)} 件`;
      if (!confirmed) {
        output.info(
          `${summary}。何も変えていません（実行するには、--yes を付けます）。認証情報は、コピーしません（設備ごとに、画面から、入力し直します）`,
        );
      } else {
        for (const target of targets) {
          await container.equipmentConnections.save(target.equipmentId, target.connection);
        }
        output.info(
          `${summary}。コピーしました（${String(targets.length)} 件）。認証情報は、コピーしていません。設備ごとに、画面から、入力し直してください`,
        );
      }
    } finally {
      container.close();
    }
    return 0;
  } catch (error) {
    output.error(`設備ごとの接続へ移せませんでした: ${describeFailure(error)}`);
    return 1;
  }
}

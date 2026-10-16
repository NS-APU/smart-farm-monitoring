/**
 * 最初のユーザー（管理者）を作るコマンド（`pnpm initial-user`。ADR-0008）。
 * Cognito を使う構成では、Lambda は、環境変数の初期ユーザー（INITIAL_USER_*）を読まない。代わりに、
 * 利用者（運用者）が、AWS のプロファイルを指定して、手元で、1 回だけ実行する。
 *
 * - Cognito のユーザー（パスワードつき）と、DynamoDB のユーザーの記録（名前・ロール）を、同時に作る
 * - ユーザーが 1 人でもいれば、何もしない（何度実行しても、既存のユーザーを上書きしない）
 * - パスワードは、実行するときの環境変数で渡し、保存しない。画面・ログには、出力しない
 * - AWS のエラーは、名前だけを出力する（メッセージに、アカウント ID・ARN が含まれることがあり、
 *   チャット・Issue・PR に貼らないため。security.md）
 *
 * 環境変数: Lambda と同じ AUTH_PROVIDER=cognito・PERSISTENCE=dynamodb・COGNITO_*・DYNAMODB_*_TABLE
 * （値は、SfmData のスタックの出力）に、INITIAL_USER_ID・INITIAL_USER_NAME・INITIAL_USER_PASSWORD（必須）、
 * INITIAL_USER_ROLE（省略時は、ユーザー管理の権限を持つ最初のロール）。AWS_REGION の既定は ap-northeast-1。
 */

import { AppError } from '@smart-farm/shared/errors';
import { ensureInitialUser } from '../infrastructure/local/initial-user.ts';
import { ConfigError, parseConfig, parseInitialUserEnv, type AppConfig } from './config.ts';
import { createContainer, type ContainerOverrides } from './container.ts';

export interface CommandOutput {
  info(message: string): void;
  error(message: string): void;
}

const DEFAULT_REGION = 'ap-northeast-1';
const INITIAL_USER_KEYS = [
  'INITIAL_USER_ID',
  'INITIAL_USER_NAME',
  'INITIAL_USER_PASSWORD',
  'INITIAL_USER_ROLE',
] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Lambda と同じ設定（INITIAL_USER_* を除く）。INITIAL_USER_* があると、設定の検証が、拒否するため。 */
function withoutInitialUser(env: Env): Env {
  const excluded: readonly string[] = INITIAL_USER_KEYS;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !excluded.includes(key)));
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof AppError) {
    return error.message;
  }
  return `AWS の操作に失敗しました（${error instanceof Error ? error.name : '不明なエラー'}）。権限・プロファイル・リージョン・ID の設定を確認してください`;
}

export async function runInitialUserCli(
  env: Env,
  output: CommandOutput,
  overrides: ContainerOverrides = {},
  now: () => Date = () => new Date(),
): Promise<number> {
  try {
    const config: AppConfig = parseConfig({
      AWS_REGION: DEFAULT_REGION,
      ...withoutInitialUser(env),
    });
    if (config.cognito === undefined) {
      throw new ConfigError('AUTH_PROVIDER=cognito・PERSISTENCE=dynamodb などの設定が必要です');
    }
    const initialUser = parseInitialUserEnv(env, config.roles);
    if (initialUser === undefined) {
      throw new ConfigError(
        'INITIAL_USER_ID / INITIAL_USER_NAME / INITIAL_USER_PASSWORD を指定してください',
      );
    }
    const container = createContainer(config, overrides);
    try {
      const created = await ensureInitialUser(
        container.repositories.users,
        initialUser,
        now(),
        container.credentials,
      );
      output.info(
        created
          ? `最初のユーザー（${initialUser.userId}）を作成しました`
          : 'ユーザーがすでにいるため、何もしませんでした',
      );
    } finally {
      container.close();
    }
    return 0;
  } catch (error) {
    output.error(`最初のユーザーを作成できませんでした: ${describeFailure(error)}`);
    return 1;
  }
}

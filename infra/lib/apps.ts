/**
 * CDK のアプリの組み立て。`bin/` のエントリは、環境変数を渡して呼ぶだけにする（テストできるように、ここに置く）。
 * - 評価環境のアプリ（bin/infra.ts）: データのスタック（DynamoDB）と、評価環境のスタック（独自ドメインがあれば、証明書のスタックも）。
 *   環境変数 SFM_ENVIRONMENT（development・production）で、開発サイト・本番サイトの、どちらか一方のスタックだけを作る（Issue #117）
 * - GitHub の OIDC のアプリ（bin/github-oidc.ts）: ユーザーが 1 回だけ、手元から実行する
 */

import { App, Tags } from 'aws-cdk-lib';
import { CertificateStack } from './certificate-stack.ts';
import {
  CERTIFICATE_REGION,
  GITHUB_REPOSITORY,
  GITHUB_SUBJECT_PREFIX,
  REGION,
  STACK_NAMES,
  readConfig,
  type SiteEnvironment,
} from './config.ts';
import { DataStack } from './data-stack.ts';
import { EvaluationStack } from './evaluation-stack.ts';
import { DEFAULT_DEPLOY_ROLES, GithubOidcStack } from './github-oidc-stack.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** コスト配分・棚卸し用のタグ（NFR-1.5）。コスト配分タグとして使うには、Billing の画面で、有効化が必要。 */
function addTags(app: App, environment: SiteEnvironment): void {
  Tags.of(app).add('Project', 'smart-farm-monitoring');
  Tags.of(app).add('Environment', environment);
  Tags.of(app).add('ManagedBy', 'cdk');
}

export function createEvaluationApp(env: Env, frontendAssetPath: string): App {
  const config = readConfig(env);
  const app = new App();
  addTags(app, config.environment);
  const names = STACK_NAMES[config.environment];
  // 本番サイトは、合成データを生成しない（実データを扱う環境に、合成データを入れない。ADR-0013）
  const includeDemoFeed = config.environment === 'development';
  const stackEnv =
    config.account === undefined ? undefined : { account: config.account, region: REGION };
  // データは、評価環境と別のスタックにする（評価環境を削除・再作成しても、データを失わない）
  const data = new DataStack(app, names.data, stackEnv === undefined ? {} : { env: stackEnv });
  const { domainName, hostedZoneName } = config;
  if (domainName === undefined || hostedZoneName === undefined || config.account === undefined) {
    new EvaluationStack(app, names.evaluation, {
      ...(stackEnv === undefined ? {} : { env: stackEnv }),
      frontendAssetPath,
      data,
      includeDemoFeed,
    });
    return app;
  }
  const certificateStack = new CertificateStack(app, names.certificate, {
    env: { account: config.account, region: CERTIFICATE_REGION },
    domainName,
    hostedZoneName,
  });
  new EvaluationStack(app, names.evaluation, {
    env: { account: config.account, region: REGION },
    crossRegionReferences: true,
    frontendAssetPath,
    data,
    includeDemoFeed,
    domainName,
    hostedZoneName,
    certificate: certificateStack.certificate,
  });
  return app;
}

export function createGithubOidcApp(env: Env): App {
  const config = readConfig(env);
  const app = new App();
  // アカウント共通のスタック（開発・本番の両方のロールを持つ）。Environment のタグは、付けない
  Tags.of(app).add('Project', 'smart-farm-monitoring');
  Tags.of(app).add('ManagedBy', 'cdk');
  new GithubOidcStack(app, 'SfmGithubOidc', {
    ...(config.account === undefined ? {} : { env: { account: config.account, region: REGION } }),
    repository: GITHUB_REPOSITORY,
    subjectPrefix: GITHUB_SUBJECT_PREFIX,
    deployRoles: DEFAULT_DEPLOY_ROLES,
    ...(config.existingOidcProviderArn === undefined
      ? {}
      : { existingProviderArn: config.existingOidcProviderArn }),
  });
  return app;
}

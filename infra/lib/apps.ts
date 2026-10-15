/**
 * CDK のアプリの組み立て。`bin/` のエントリは、環境変数を渡して呼ぶだけにする（テストできるように、ここに置く）。
 * - 評価環境のアプリ（bin/infra.ts）: データのスタック（DynamoDB）と、評価環境のスタック（独自ドメインがあれば、証明書のスタックも）
 * - GitHub の OIDC のアプリ（bin/github-oidc.ts）: ユーザーが 1 回だけ、手元から実行する
 */

import { App, Tags } from 'aws-cdk-lib';
import { CertificateStack } from './certificate-stack.ts';
import {
  CERTIFICATE_REGION,
  DEPLOY_ENVIRONMENT_NAME,
  GITHUB_REPOSITORY,
  GITHUB_SUBJECT_PREFIX,
  REGION,
  readConfig,
} from './config.ts';
import { DataStack } from './data-stack.ts';
import { EvaluationStack } from './evaluation-stack.ts';
import { GithubOidcStack } from './github-oidc-stack.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** コスト配分・棚卸し用のタグ（NFR-1.5）。コスト配分タグとして使うには、Billing の画面で、有効化が必要。 */
function addTags(app: App): void {
  Tags.of(app).add('Project', 'smart-farm-monitoring');
  Tags.of(app).add('Environment', DEPLOY_ENVIRONMENT_NAME);
  Tags.of(app).add('ManagedBy', 'cdk');
}

export function createEvaluationApp(env: Env, frontendAssetPath: string): App {
  const config = readConfig(env);
  const app = new App();
  addTags(app);
  const stackEnv =
    config.account === undefined ? undefined : { account: config.account, region: REGION };
  // データは、評価環境と別のスタックにする（評価環境を削除・再作成しても、データを失わない）
  new DataStack(app, 'SfmData', stackEnv === undefined ? {} : { env: stackEnv });
  const { domainName, hostedZoneName } = config;
  if (domainName === undefined || hostedZoneName === undefined || config.account === undefined) {
    new EvaluationStack(app, 'SfmEvaluation', {
      ...(stackEnv === undefined ? {} : { env: stackEnv }),
      frontendAssetPath,
    });
    return app;
  }
  const certificateStack = new CertificateStack(app, 'SfmEvaluationCertificate', {
    env: { account: config.account, region: CERTIFICATE_REGION },
    domainName,
    hostedZoneName,
  });
  new EvaluationStack(app, 'SfmEvaluation', {
    env: { account: config.account, region: REGION },
    crossRegionReferences: true,
    frontendAssetPath,
    domainName,
    hostedZoneName,
    certificate: certificateStack.certificate,
  });
  return app;
}

export function createGithubOidcApp(env: Env): App {
  const config = readConfig(env);
  const app = new App();
  addTags(app);
  new GithubOidcStack(app, 'SfmGithubOidc', {
    ...(config.account === undefined ? {} : { env: { account: config.account, region: REGION } }),
    repository: GITHUB_REPOSITORY,
    subjectPrefix: GITHUB_SUBJECT_PREFIX,
    environmentName: DEPLOY_ENVIRONMENT_NAME,
    ...(config.existingOidcProviderArn === undefined
      ? {}
      : { existingProviderArn: config.existingOidcProviderArn }),
  });
  return app;
}

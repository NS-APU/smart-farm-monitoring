/**
 * GitHub Actions から AWS へ、一時的な認証（OIDC）でデプロイするための、プロバイダーとロールのスタック。Issue #71。
 * 長期のアクセスキーを、GitHub にも、リポジトリにも置かない（security.md）。
 *
 * - ロールを引き受けられるのは、このリポジトリの、GitHub の Environment（既定: evaluation）で動くジョブだけ
 *   （Environment に、承認者・ブランチの制限を設定すると、デプロイを、さらに絞れる）
 * - ロールの権限は、CDK のデプロイ用ロール（cdk bootstrap が作る `cdk-<qualifier>-*`）を、引き受けることだけ
 *   （リソースの作成・変更は、CDK のデプロイ用ロールの権限で行う）
 * - このスタックは、ユーザーが 1 回だけ、手元から実行する（`bin/github-oidc.ts`）。GitHub Actions からは、実行しない
 */

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  OidcProviderNative,
  PolicyDocument,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { type Construct } from 'constructs';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const DEPLOY_ROLE_NAME = 'sfm-github-actions-deploy';
/** `cdk bootstrap` の既定の識別子。 */
export const DEFAULT_BOOTSTRAP_QUALIFIER = 'hnb659fds';

export interface GithubOidcStackProps extends StackProps {
  /** デプロイを許可するリポジトリ（例: NS-APU/smart-farm-monitoring）。 */
  readonly repository: string;
  /** デプロイを許可する GitHub の Environment の名前。 */
  readonly environmentName: string;
  /** アカウントに、GitHub の OIDC プロバイダーが、すでにある場合の ARN（1 つのアカウントに 1 つしか作れない）。 */
  readonly existingProviderArn?: string;
  /** `cdk bootstrap` の識別子。 */
  readonly bootstrapQualifier?: string;
}

export class GithubOidcStack extends Stack {
  readonly deployRole: Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const qualifier = props.bootstrapQualifier ?? DEFAULT_BOOTSTRAP_QUALIFIER;
    const providerArn =
      props.existingProviderArn ??
      new OidcProviderNative(this, 'GithubProvider', {
        url: `https://${GITHUB_OIDC_HOST}`,
        clientIds: ['sts.amazonaws.com'],
      }).oidcProviderArn;

    this.deployRole = new Role(this, 'DeployRole', {
      roleName: DEPLOY_ROLE_NAME,
      // IAM の説明には、日本語を使えない（Latin-1 のみ）
      description: 'Assumed by GitHub Actions via OIDC to deploy with CDK',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: `repo:${props.repository}:environment:${props.environmentName}`,
        },
      }),
      inlinePolicies: {
        AssumeCdkRoles: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-*`],
            }),
          ],
        }),
      },
    });

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'GitHub の Environment のシークレット AWS_DEPLOY_ROLE_ARN に設定する',
    });
  }
}

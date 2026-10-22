/**
 * GitHub Actions から AWS へ、一時的な認証（OIDC）でデプロイするための、プロバイダーとロールのスタック。Issue #71。
 * 長期のアクセスキーを、GitHub にも、リポジトリにも置かない（security.md）。
 *
 * - ロールは、サイトの環境（開発・本番。Issue #117。ADR-0013）ごとに 1 つ。ロールを引き受けられるのは、このリポジトリの、
 *   対応する GitHub の Environment（development・production）で動くジョブだけ（開発サイトのジョブは、本番のロールを引き受けられない）。
 *   Environment に、承認者・ブランチの制限を設定すると、デプロイを、さらに絞れる
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
/** 開発サイトのロールの名前（Issue #71 から。変えない）。 */
export const DEPLOY_ROLE_NAME = 'sfm-github-actions-deploy';
/** 本番サイトのロールの名前（Issue #117）。 */
export const PRODUCTION_DEPLOY_ROLE_NAME = 'sfm-github-actions-deploy-production';

export interface DeployRoleSpec {
  /** コンストラクトの ID（論理 ID になる。**既存のロールの ID は、変えない**。変えると、ロールが置き換わる）。 */
  readonly id: string;
  readonly roleName: string;
  /** このロールを引き受けられる、GitHub の Environment の名前。 */
  readonly environmentName: string;
  /** ロールの ARN の出力の ID。 */
  readonly outputId: string;
}

/** 既定のロール: 開発サイト（既存）と、本番サイト。 */
export const DEFAULT_DEPLOY_ROLES: readonly DeployRoleSpec[] = [
  {
    id: 'DeployRole',
    roleName: DEPLOY_ROLE_NAME,
    environmentName: 'development',
    outputId: 'DeployRoleArn',
  },
  {
    id: 'ProductionDeployRole',
    roleName: PRODUCTION_DEPLOY_ROLE_NAME,
    environmentName: 'production',
    outputId: 'ProductionDeployRoleArn',
  },
];
/** `cdk bootstrap` の既定の識別子。 */
export const DEFAULT_BOOTSTRAP_QUALIFIER = 'hnb659fds';

export interface GithubOidcStackProps extends StackProps {
  /** デプロイを許可するリポジトリ（例: NS-APU/smart-farm-monitoring）。 */
  readonly repository: string;
  /** 環境ごとのデプロイ用のロール（引き受けられる Environment が、それぞれ別）。 */
  readonly deployRoles: readonly DeployRoleSpec[];
  /** アカウントに、GitHub の OIDC プロバイダーが、すでにある場合の ARN（1 つのアカウントに 1 つしか作れない）。 */
  readonly existingProviderArn?: string;
  /** `cdk bootstrap` の識別子。 */
  readonly bootstrapQualifier?: string;
  /**
   * GitHub の OIDC トークンの `sub` の接頭辞。GitHub の新しい既定（不変の ID の形式）では、
   * `repo:<組織>@<組織の ID>/<リポジトリ>@<リポジトリの ID>` になる（リポジトリの設定 `use_immutable_subject`）。
   * 指定しなければ、旧形式の `repo:<repository>`（名前だけ）を使う。実際の値の確認方法は、config.ts の GITHUB_SUBJECT_PREFIX。
   */
  readonly subjectPrefix?: string;
}

export class GithubOidcStack extends Stack {
  /** `deployRoles` と同じ順のロール。 */
  readonly deployRoles: readonly Role[];

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const qualifier = props.bootstrapQualifier ?? DEFAULT_BOOTSTRAP_QUALIFIER;
    const subjectPrefix = props.subjectPrefix ?? `repo:${props.repository}`;
    const providerArn =
      props.existingProviderArn ??
      new OidcProviderNative(this, 'GithubProvider', {
        url: `https://${GITHUB_OIDC_HOST}`,
        clientIds: ['sts.amazonaws.com'],
      }).oidcProviderArn;

    this.deployRoles = props.deployRoles.map((spec) => {
      const role = new Role(this, spec.id, {
        roleName: spec.roleName,
        // IAM の説明には、日本語を使えない（Latin-1 のみ）
        description: `Assumed by GitHub Actions via OIDC to deploy with CDK (${spec.environmentName})`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: `${subjectPrefix}:environment:${spec.environmentName}`,
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
      new CfnOutput(this, spec.outputId, {
        value: role.roleArn,
        description: `GitHub の Environment「${spec.environmentName}」のシークレット AWS_DEPLOY_ROLE_ARN に設定する`,
      });
      return role;
    });
  }
}

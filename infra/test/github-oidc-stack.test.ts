import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEPLOY_ROLES,
  DEPLOY_ROLE_NAME,
  GithubOidcStack,
  PRODUCTION_DEPLOY_ROLE_NAME,
} from '../lib/github-oidc-stack.ts';

const ENV = { account: '111111111111', region: 'ap-northeast-1' } as const;

function build(
  props: { existingProviderArn?: string; bootstrapQualifier?: string; subjectPrefix?: string } = {},
): Template {
  const stack = new GithubOidcStack(new App(), 'Oidc', {
    env: ENV,
    repository: 'example-org/example-repo',
    deployRoles: DEFAULT_DEPLOY_ROLES,
    ...props,
  });
  return Template.fromStack(stack);
}

/** 引き受け先のロール（cdk-<識別子>-*）の ARN を、権限のリソースとして持つこと。 */
function assumesOnlyCdkRoles(qualifier: string): ReturnType<typeof Match.objectLike> {
  return Match.objectLike({
    PolicyName: 'AssumeCdkRoles',
    PolicyDocument: {
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Resource: {
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp(`role/cdk-${qualifier}-\\*$`)]),
            ]),
          },
        },
      ],
    },
  });
}

describe('GitHub Actions の OIDC のスタック', () => {
  it('GitHub の OIDC プロバイダーを作る（クライアント ID は sts.amazonaws.com）', () => {
    build().hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
  });

  it('ロールを引き受けられるのは、指定したリポジトリの Environment のジョブだけ', () => {
    build().hasResourceProperties('AWS::IAM::Role', {
      RoleName: DEPLOY_ROLE_NAME,
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:example-org/example-repo:environment:development',
              },
            },
          }),
        ],
      },
    });
  });

  it('主体（sub）の接頭辞を指定すると、不変の ID の形式（組織・リポジトリの ID を含む）を条件にできる', () => {
    // GitHub の新しい既定では、トークンの sub は、リポジトリの名前ではなく、ID を含む形になる（Issue #87）
    build({ subjectPrefix: 'repo:example-org@111/example-repo@222' }).hasResourceProperties(
      'AWS::IAM::Role',
      {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub':
                    'repo:example-org@111/example-repo@222:environment:development',
                },
              },
            }),
          ],
        },
      },
    );
  });

  it('ロールの権限は、CDK のデプロイ用ロールを引き受けることだけ（既定の識別子）', () => {
    build().hasResourceProperties('AWS::IAM::Role', {
      Policies: [assumesOnlyCdkRoles('hnb659fds')],
    });
  });

  it('bootstrap の識別子を変えると、引き受け先のロール名も変わる', () => {
    build({ bootstrapQualifier: 'custom01' }).hasResourceProperties('AWS::IAM::Role', {
      Policies: [assumesOnlyCdkRoles('custom01')],
    });
  });

  it('プロバイダーが、すでにあるときは、新しく作らず、その ARN を使う', () => {
    const arn = 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com';
    const template = build({ existingProviderArn: arn });
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Federated: arn } })],
      },
    });
  });

  it('ロールの ARN を出力する（GitHub のシークレットに設定する）', () => {
    expect(Object.keys(build().findOutputs('DeployRoleArn'))).toEqual(['DeployRoleArn']);
    expect(Object.keys(build().findOutputs('ProductionDeployRoleArn'))).toEqual([
      'ProductionDeployRoleArn',
    ]);
  });

  it('ロールは、開発サイトと本番サイトの 2 つ（Issue #117）。本番のロールを引き受けられるのは、Environment「production」のジョブだけ', () => {
    const template = build();
    template.resourceCountIs('AWS::IAM::Role', 2);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: PRODUCTION_DEPLOY_ROLE_NAME,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:example-org/example-repo:environment:production',
              },
            },
          }),
        ],
      },
    });
  });

  it('開発サイトのロールは、production の Environment を許さず、本番サイトのロールは、development の Environment を許さない', () => {
    const roles = Object.values(build().findResources('AWS::IAM::Role')) as {
      Properties: {
        RoleName: string;
        AssumeRolePolicyDocument: {
          Statement: { Condition: { StringEquals: Record<string, string> } }[];
        };
      };
    }[];
    const subjectOf = (roleName: string): string | undefined =>
      roles.find((role) => role.Properties.RoleName === roleName)?.Properties
        .AssumeRolePolicyDocument.Statement[0]?.Condition.StringEquals[
        'token.actions.githubusercontent.com:sub'
      ];

    expect(subjectOf(DEPLOY_ROLE_NAME)).toMatch(/:environment:development$/);
    expect(subjectOf(PRODUCTION_DEPLOY_ROLE_NAME)).toMatch(/:environment:production$/);
  });

  it('開発サイトの既存のロールは、置き換わらない（コンストラクトの ID・ロール名・出力の ID が、これまでと同じ）', () => {
    const template = build();
    const logicalIds = Object.keys(template.findResources('AWS::IAM::Role'));
    expect(
      logicalIds.some((id) => id.startsWith('DeployRole') && !id.startsWith('DeployRoleP')),
    ).toBe(true);
    expect(DEPLOY_ROLE_NAME).toBe('sfm-github-actions-deploy');
    expect(DEFAULT_DEPLOY_ROLES[0]).toMatchObject({
      id: 'DeployRole',
      roleName: 'sfm-github-actions-deploy',
      outputId: 'DeployRoleArn',
    });
  });
});

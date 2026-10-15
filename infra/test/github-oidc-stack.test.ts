import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DEPLOY_ROLE_NAME, GithubOidcStack } from '../lib/github-oidc-stack.ts';

const ENV = { account: '111111111111', region: 'ap-northeast-1' } as const;

function build(
  props: { existingProviderArn?: string; bootstrapQualifier?: string } = {},
): Template {
  const stack = new GithubOidcStack(new App(), 'Oidc', {
    env: ENV,
    repository: 'example-org/example-repo',
    environmentName: 'evaluation',
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
                  'repo:example-org/example-repo:environment:evaluation',
              },
            },
          }),
        ],
      },
    });
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
  });
});

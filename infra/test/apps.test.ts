import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { createEvaluationApp, createGithubOidcApp } from '../lib/apps.ts';
import { GITHUB_SUBJECT_PREFIX } from '../lib/config.ts';

function assets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfm-infra-apps-'));
  writeFileSync(join(dir, 'index.html'), '<title>test</title>');
  return dir;
}

function stackNames(app: App): string[] {
  return app.node.children.map((child) => child.node.id).sort();
}

describe('CDK アプリの組み立て', () => {
  it('評価環境: 設定がなければ、評価環境のスタックだけを作る（アカウントに依存しない）', () => {
    const app = createEvaluationApp({}, assets());
    expect(stackNames(app)).toEqual(['SfmEvaluation']);
  });

  it('評価環境: アカウントだけを指定しても、証明書のスタックは作らない', () => {
    const app = createEvaluationApp({ CDK_DEFAULT_ACCOUNT: '111111111111' }, assets());
    expect(stackNames(app)).toEqual(['SfmEvaluation']);
  });

  it('評価環境: 独自ドメインを指定すると、証明書（us-east-1）のスタックも作る', () => {
    const app = createEvaluationApp(
      {
        CDK_DEFAULT_ACCOUNT: '111111111111',
        SFM_DOMAIN_NAME: 'eval.example.com',
        SFM_HOSTED_ZONE_NAME: 'example.com',
      },
      assets(),
    );
    expect(stackNames(app)).toEqual(['SfmEvaluation', 'SfmEvaluationCertificate']);
    const regions = app
      .synth()
      .stacks.map((stack) => `${stack.stackName}:${stack.environment.region}`);
    expect(regions.sort()).toEqual([
      'SfmEvaluation:ap-northeast-1',
      'SfmEvaluationCertificate:us-east-1',
    ]);
  });

  it('評価環境: 設定の誤り（ドメインだけの指定）は、エラーにする', () => {
    expect(() => createEvaluationApp({ SFM_DOMAIN_NAME: 'eval.example.com' }, assets())).toThrow(
      '2 つとも',
    );
  });

  it('GitHub の OIDC: ロールのスタックを作る。既存のプロバイダーの ARN も使える', () => {
    expect(stackNames(createGithubOidcApp({}))).toEqual(['SfmGithubOidc']);
    const arn = 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com';
    const app = createGithubOidcApp({
      CDK_DEFAULT_ACCOUNT: '111111111111',
      SFM_GITHUB_OIDC_PROVIDER_ARN: arn,
    });
    expect(stackNames(app)).toEqual(['SfmGithubOidc']);
    const template = app.synth().getStackByName('SfmGithubOidc').template as {
      Resources: Record<string, { Type: string }>;
    };
    expect(Object.values(template.Resources).some((r) => r.Type === 'AWS::IAM::OIDCProvider')).toBe(
      false,
    );
  });

  it('GitHub の OIDC: このリポジトリの GitHub のトークンの sub（不変の ID の形式）を、ロールの信頼条件にする（Issue #87）', () => {
    const app = createGithubOidcApp({});
    const template = app.synth().getStackByName('SfmGithubOidc').template as {
      Resources: Record<
        string,
        {
          Type: string;
          Properties: {
            AssumeRolePolicyDocument?: {
              Statement: { Condition: { StringEquals: Record<string, string> } }[];
            };
          };
        }
      >;
    };
    const role = Object.values(template.Resources).find((r) => r.Type === 'AWS::IAM::Role');
    const sub =
      role?.Properties.AssumeRolePolicyDocument?.Statement[0]?.Condition.StringEquals[
        'token.actions.githubusercontent.com:sub'
      ];
    expect(sub).toBe(`${GITHUB_SUBJECT_PREFIX}:environment:evaluation`);
    // 不変の ID の形式: repo:<組織>@<組織の ID>/<リポジトリ>@<リポジトリの ID>
    expect(sub).toMatch(/^repo:[^@/]+@\d+\/[^@/]+@\d+:environment:evaluation$/);
  });

  it('全スタックに、コスト配分用のタグ（Project・Environment・ManagedBy）が付く', () => {
    const app = createGithubOidcApp({});
    const template = app.synth().getStackByName('SfmGithubOidc').template as {
      Resources: Record<
        string,
        { Type: string; Properties: { Tags?: { Key: string; Value: string }[] } }
      >;
    };
    const role = Object.values(template.Resources).find((r) => r.Type === 'AWS::IAM::Role');
    expect(role?.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Project', Value: 'smart-farm-monitoring' },
        { Key: 'Environment', Value: 'evaluation' },
        { Key: 'ManagedBy', Value: 'cdk' },
      ]),
    );
  });
});

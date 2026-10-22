import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App } from 'aws-cdk-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvaluationApp, createGithubOidcApp } from '../lib/apps.ts';
import { GITHUB_SUBJECT_PREFIX } from '../lib/config.ts';

// スタックの名前だけを確かめるテスト。Lambda のコードのまとめ（esbuild）は、スタックを作るたびに走り、CPU を使う。
// まとめの確認は、bundle-lambda.test.ts で行うため、ここでは省く（CDK のコンテキストを、環境変数で渡す）。
// 重いテストが、ほかのテストと並列に動くとき、時間の上限を超えることを避ける（上限は、緩めない）
beforeAll(() => {
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ 'aws:cdk:bundling-stacks': [] });
});
afterAll(() => {
  delete process.env.CDK_CONTEXT_JSON;
});

function assets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfm-infra-apps-'));
  writeFileSync(join(dir, 'index.html'), '<title>test</title>');
  return dir;
}

function stackNames(app: App): string[] {
  return app.node.children.map((child) => child.node.id).sort();
}

describe('CDK アプリの組み立て', () => {
  it('評価環境: 設定がなければ、データと評価環境のスタックだけを作る（アカウントに依存しない）', () => {
    const app = createEvaluationApp({}, assets());
    expect(stackNames(app)).toEqual(['SfmData', 'SfmEvaluation']);
  });

  it('評価環境: アカウントだけを指定しても、証明書のスタックは作らない', () => {
    const app = createEvaluationApp({ CDK_DEFAULT_ACCOUNT: '111111111111' }, assets());
    expect(stackNames(app)).toEqual(['SfmData', 'SfmEvaluation']);
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
    expect(stackNames(app)).toEqual(['SfmData', 'SfmEvaluation', 'SfmEvaluationCertificate']);
    const regions = app
      .synth()
      .stacks.map((stack) => `${stack.stackName}:${stack.environment.region}`);
    expect(regions.sort()).toEqual([
      'SfmData:ap-northeast-1',
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
    expect(sub).toBe(`${GITHUB_SUBJECT_PREFIX}:environment:development`);
    // 不変の ID の形式: repo:<組織>@<組織の ID>/<リポジトリ>@<リポジトリの ID>
    expect(sub).toMatch(/^repo:[^@/]+@\d+\/[^@/]+@\d+:environment:development$/);
  });

  it('評価環境のスタックに、コスト配分用のタグ（Project・Environment・ManagedBy）が付く。Environment は、サイトの環境（Issue #117）', () => {
    for (const environment of ['development', 'production'] as const) {
      const app = createEvaluationApp({ SFM_ENVIRONMENT: environment }, assets());
      const dataStack = app.synth().stacks.find((stack) => stack.stackName.endsWith('Data'));
      const template = dataStack?.template as {
        Resources: Record<
          string,
          { Type: string; Properties: { Tags?: { Key: string; Value: string }[] } }
        >;
      };
      const table = Object.values(template.Resources).find(
        (r) => r.Type === 'AWS::DynamoDB::Table',
      );
      expect(table?.Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'Project', Value: 'smart-farm-monitoring' },
          { Key: 'Environment', Value: environment },
          { Key: 'ManagedBy', Value: 'cdk' },
        ]),
      );
    }
  });

  it('GitHub の OIDC のスタックは、アカウント共通（開発・本番のロールを持つ）。タグは、Project・ManagedBy', () => {
    const app = createGithubOidcApp({});
    const template = app.synth().getStackByName('SfmGithubOidc').template as {
      Resources: Record<
        string,
        { Type: string; Properties: { Tags?: { Key: string; Value: string }[] } }
      >;
    };
    const roles = Object.values(template.Resources).filter((r) => r.Type === 'AWS::IAM::Role');
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect(role.Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'Project', Value: 'smart-farm-monitoring' },
          { Key: 'ManagedBy', Value: 'cdk' },
        ]),
      );
    }
  });

  it('本番サイト（SFM_ENVIRONMENT=production）: 開発サイトとは別の名前のスタックを作る（データ・ユーザー・URL を共有しない）', () => {
    const production = createEvaluationApp({ SFM_ENVIRONMENT: 'production' }, assets());
    const development = createEvaluationApp({}, assets());

    expect(stackNames(production)).toEqual(['SfmProductionData', 'SfmProductionEvaluation']);
    expect(stackNames(development)).toEqual(['SfmData', 'SfmEvaluation']);
    const shared = stackNames(production).filter((name) => stackNames(development).includes(name));
    expect(shared).toEqual([]);
  });

  it('本番サイト: 独自ドメインを指定すると、本番用の名前の証明書（us-east-1）のスタックも作る', () => {
    const app = createEvaluationApp(
      {
        SFM_ENVIRONMENT: 'production',
        CDK_DEFAULT_ACCOUNT: '111111111111',
        SFM_DOMAIN_NAME: 'prod.example.com',
        SFM_HOSTED_ZONE_NAME: 'example.com',
      },
      assets(),
    );

    expect(stackNames(app)).toEqual([
      'SfmProductionData',
      'SfmProductionEvaluation',
      'SfmProductionEvaluationCertificate',
    ]);
  });

  it('本番サイトは、合成データを生成する Lambda・ルールを作らない。開発サイトは、作る（実データを扱う環境に、合成データを入れない。ADR-0013）', () => {
    const resourcesOf = (environment: 'development' | 'production') => {
      const app = createEvaluationApp({ SFM_ENVIRONMENT: environment }, assets());
      const stack = app.synth().stacks.find((item) => item.stackName.endsWith('Evaluation'));
      const template = stack?.template as {
        Resources: Record<string, { Type: string }>;
        Outputs?: Record<string, unknown>;
      };
      return {
        demoIds: Object.keys(template.Resources).filter((id) => id.includes('DemoFeed')),
        outputs: Object.keys(template.Outputs ?? {}),
        buckets: Object.values(template.Resources).filter((r) => r.Type === 'AWS::S3::Bucket')
          .length,
      };
    };

    const development = resourcesOf('development');
    const production = resourcesOf('production');

    expect(development.demoIds.length).toBeGreaterThan(0);
    expect(development.outputs).toContain('DemoFeedFunctionName');
    expect(production.demoIds).toEqual([]);
    expect(production.outputs).not.toContain('DemoFeedFunctionName');
    // ファイルサーバーのモックのバケット（空のまま）は、どちらにもある（Lambda の取り込みの失敗を避ける）
    expect(production.outputs).toContain('FileServerBucketName');
    expect(production.buckets).toBe(development.buckets);
  });

  it('サイトの環境の指定が不正なら、エラーにする', () => {
    expect(() => createEvaluationApp({ SFM_ENVIRONMENT: 'staging' }, assets())).toThrow(
      'SFM_ENVIRONMENT',
    );
  });
});

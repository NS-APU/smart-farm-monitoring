import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { describe, expect, it } from 'vitest';
import { DataStack } from '../lib/data-stack.ts';
import {
  COGNITO_ACTIONS,
  DYNAMODB_ACTIONS,
  CLIENT_IP_HEADER,
  EvaluationStack,
  SPA_REWRITE_CODE,
  VIEWER_IP_CODE,
} from '../lib/evaluation-stack.ts';

const ENV = { account: '111111111111', region: 'ap-northeast-1' } as const;
const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000';

/** Lambda のバンドル（esbuild）を省く。バンドルは、bundle-lambda.test.ts で確認する。 */
function newApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/** ビルドした画面の代わりに使う、ごく小さなディレクトリ。 */
function frontendAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfm-infra-site-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>test</title>');
  return dir;
}

function plainStack(): { stack: EvaluationStack; template: Template } {
  const app = newApp();
  const stack = new EvaluationStack(app, 'Evaluation', {
    frontendAssetPath: frontendAssets(),
    data: new DataStack(app, 'Data'),
  });
  return { stack, template: Template.fromStack(stack) };
}

/** CloudFront 用の証明書は、us-east-1 のもの（実際は、証明書のスタックが作る）。 */
function dummyCertificate(app: App): Certificate {
  return Certificate.fromCertificateArn(
    new Stack(app, 'Dummy', { env: ENV }),
    'Certificate',
    CERTIFICATE_ARN,
  ) as Certificate;
}

function domainStack(): { stack: EvaluationStack; template: Template } {
  const app = newApp();
  const stack = new EvaluationStack(app, 'Evaluation', {
    env: ENV,
    frontendAssetPath: frontendAssets(),
    data: new DataStack(app, 'Data', { env: ENV }),
    domainName: 'eval.example.com',
    hostedZoneName: 'example.com',
    certificate: dummyCertificate(app),
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('評価環境のスタック: 画面の配信（S3 + CloudFront）', () => {
  it('バケットは、公開せず、SSL を強制し、暗号化し、削除のときは中身ごと削除する', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('バケットは、CloudFront の OAC（SigV4）からだけ読める', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
          }),
        ]),
      },
    });
  });

  it('画面は、HTTPS へ転送し、セキュリティヘッダーを付け、SPA の深いパスを index.html に書き換える', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_200',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: SPA_REWRITE_CODE,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
    expect(SPA_REWRITE_CODE).toContain("indexOf('.') === -1");
  });

  it('API の入口で、利用者の IP を、専用のヘッダーに上書きで入れる（利用者が同名のヘッダーを付けても、無効）（Issue #100）', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: VIEWER_IP_CODE,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });

    const handler = runInNewContext(`${VIEWER_IP_CODE}\nhandler;`) as (event: unknown) => {
      headers: Record<string, { value: string }>;
    };
    const forged = handler({
      request: {
        headers: { [CLIENT_IP_HEADER]: { value: '192.0.2.1' }, host: { value: 'example' } },
      },
      viewer: { ip: '2001:db8::5' },
    });
    const none = handler({ request: { headers: {} }, viewer: { ip: '203.0.113.5' } });

    expect(forged.headers[CLIENT_IP_HEADER]).toEqual({ value: '2001:db8::5' });
    expect(forged.headers.host).toEqual({ value: 'example' });
    expect(none.headers[CLIENT_IP_HEADER]).toEqual({ value: '203.0.113.5' });
  });

  it('CloudFront のエラー応答（403・404 → index.html）は、使わない（API のエラーまで書き換えるため）', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ CustomErrorResponses: Match.absent() }),
    });
  });

  it('画面のファイルを配置し、CloudFront のキャッシュを無効化する', () => {
    const { template } = plainStack();
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      Prune: true,
      DistributionPaths: ['/*'],
    });
  });
});

describe('評価環境のスタック: API（Lambda の関数の URL）', () => {
  it('/api/* と /health を、API へ向ける（HTTPS のみ・全メソッド・認証ヘッダーを渡す）', () => {
    const { template } = plainStack();
    const apiBehavior = {
      ViewerProtocolPolicy: 'https-only',
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      // 利用者の IP を、ヘッダーに入れる（Issue #100）
      FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
    };
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayEquals([
          Match.objectLike({ PathPattern: '/api/*', ...apiBehavior }),
          Match.objectLike({ PathPattern: '/health', ...apiBehavior }),
        ]),
      }),
    });
  });

  it('関数は、Node.js 24・ARM・1024 MB・29 秒（CloudFront の応答の上限 30 秒の内側）で、ログの保持期間を絞る', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 29,
      MemorySize: 1024,
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });

  it('関数の URL は認証なし（認証はアプリ側）。公開に必要な 2 つの権限がある', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      FunctionUrlAuthType: 'NONE',
      Principal: '*',
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      InvokedViaFunctionUrl: true,
      Principal: '*',
    });
  });
});

interface PolicyStatementJson {
  readonly Effect: string;
  readonly Action: string | string[];
  readonly Resource: unknown;
}

/** API の Lambda のロールに付く、インラインのポリシーの文（画面の配置など、ほかのロールは、含めない）。 */
function apiRoleStatements(template: Template): PolicyStatementJson[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { PolicyDocument: { Statement: PolicyStatementJson[] } } }
  >;
  return Object.entries(policies)
    .filter(([logicalId]) => logicalId.startsWith('ApiFunctionServiceRoleDefaultPolicy'))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

describe('評価環境のスタック: API はバックエンド本体（Issue #75。ADR-0009）', () => {
  function environmentOf(template: Template): Record<string, unknown> {
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties: { Environment?: { Variables: Record<string, unknown> } } }
    >;
    const api = Object.values(resources).find(
      (resource) =>
        resource.Type === 'AWS::Lambda::Function' &&
        resource.Properties.Environment?.Variables.APP_MODE !== undefined,
    );
    return api?.Properties.Environment?.Variables ?? {};
  }

  it('環境変数: 本番・DynamoDB・Cognito。ID・テーブル名は、データのスタックの出力を参照し、リポジトリに書かない', () => {
    const { template } = plainStack();
    const environment = environmentOf(template);

    expect(environment).toMatchObject({
      APP_MODE: 'production',
      PERSISTENCE: 'dynamodb',
      AUTH_PROVIDER: 'cognito',
      CLIENT_IP_HEADER: 'x-sfm-viewer-ip',
      LOG_LEVEL: 'info',
    });
    // 関数の URL は、X-Forwarded-For を切り詰めるため、段数による識別は、使わない（Issue #100）
    expect(environment).not.toHaveProperty('TRUSTED_PROXY_HOPS');
    expect(CLIENT_IP_HEADER).toBe('x-sfm-viewer-ip');
    for (const name of [
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'DYNAMODB_OBSERVATIONS_TABLE',
      'DYNAMODB_MAIN_TABLE',
    ]) {
      expect(JSON.stringify(environment[name])).toContain('Fn::ImportValue');
    }
  });

  it('秘密情報（パスワード・トークン・キー・シークレット）を、環境変数に持たない。開発用 API・デモデータ・初期ユーザーの設定もない', () => {
    const { template } = plainStack();
    const names = Object.keys(environmentOf(template));

    expect(names.filter((name) => /SECRET|PASSWORD|TOKEN|KEY/i.test(name))).toEqual([]);
    for (const name of ['DEV_API_ENABLED', 'SEED_MODE', 'SCHEDULER_ENABLED', 'DYNAMODB_ENDPOINT']) {
      expect(names).not.toContain(name);
    }
    expect(names.filter((name) => name.startsWith('INITIAL_USER'))).toEqual([]);
  });

  it('IAM は最小権限: DynamoDB は、2 つのテーブル（インデックスを含む）への、必要な操作だけ（Scan なし）。Cognito は、ユーザープールへの管理の 5 操作だけ', () => {
    const { template } = plainStack();
    const statements = apiRoleStatements(template);
    const actionsOf = (statement: PolicyStatementJson): string[] => [statement.Action].flat();
    const dynamodb = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('dynamodb:')),
    );
    const cognito = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('cognito-idp:')),
    );

    expect(dynamodb).toHaveLength(1);
    expect(cognito).toHaveLength(1);
    const [dynamodbStatement] = dynamodb;
    const [cognitoStatement] = cognito;
    if (dynamodbStatement === undefined || cognitoStatement === undefined) {
      throw new Error('テストの前提');
    }
    expect(actionsOf(dynamodbStatement).sort()).toEqual([...DYNAMODB_ACTIONS].sort());
    expect(actionsOf(dynamodbStatement)).not.toContain('dynamodb:Scan');
    // 2 つのテーブル + それぞれのインデックス = 4 つのリソース
    expect(dynamodbStatement.Resource).toHaveLength(4);
    expect(actionsOf(cognitoStatement).sort()).toEqual([...COGNITO_ACTIONS].sort());
    // ワイルドカードのリソース（*）の権限は、ない
    for (const statement of statements) {
      expect(statement.Resource).not.toBe('*');
    }
  });
});

describe('評価環境のスタック: ドメインと出力', () => {
  it('ドメインを指定しなければ、cloudfront.net のドメインを使い、別名・DNS のレコードを作らない', () => {
    const { stack, template } = plainStack();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.absent(),
        ViewerCertificate: Match.absent(),
      }),
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    expect(stack.siteUrl).toMatch(/^https:\/\//);
    template.hasOutput('SiteUrl', { Description: Match.anyValue() });
    template.hasOutput('DistributionId', {});
    template.hasOutput('ApiFunctionName', {});
  });

  it('独自のサブドメインを指定すると、別名・証明書・TLS 1.2 以上・A と AAAA のレコードを作る', () => {
    const { stack, template } = domainStack();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['eval.example.com'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: CERTIFICATE_ARN,
          MinimumProtocolVersion: 'TLSv1.2_2021',
          SslSupportMethod: 'sni-only',
        }),
      }),
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'eval.example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'eval.example.com.',
    });
    expect(stack.siteUrl).toBe('https://eval.example.com');
  });

  it('ドメインだけを指定する（ホストゾーン・証明書がない）と、エラーにする', () => {
    const app = newApp();
    expect(
      () =>
        new EvaluationStack(app, 'Evaluation', {
          frontendAssetPath: frontendAssets(),
          data: new DataStack(app, 'Data'),
          domainName: 'eval.example.com',
        }),
    ).toThrow('hostedZoneName と certificate');
  });

  it('ドメインが、ホストゾーンのサブドメインでなければ、エラーにする', () => {
    const app = newApp();
    expect(
      () =>
        new EvaluationStack(app, 'Evaluation', {
          env: ENV,
          frontendAssetPath: frontendAssets(),
          data: new DataStack(app, 'Data', { env: ENV }),
          domainName: 'eval.other.net',
          hostedZoneName: 'example.com',
          certificate: dummyCertificate(app),
        }),
    ).toThrow('サブドメイン');
  });
});

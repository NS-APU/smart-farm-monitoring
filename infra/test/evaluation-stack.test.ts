import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { App, Stack } from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { describe, expect, it } from 'vitest';
import {
  DEMO_FEED_INTERVAL_MINUTES,
  DEMO_FEED_SOURCE_IDS,
  DEMO_FEED_TIMEOUT_SECONDS,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import {
  DEFAULT_SCHEDULE,
  JOB_LAMBDA_TIMEOUT_SECONDS,
  JOB_LEASE_MS,
} from '../../src/backend/application/jobs/job-schedule.ts';
import { ORIGIN_SECRET_HEADER } from '../../src/backend/presentation/origin-guard.ts';
import { STATIC_CONTENT_SECURITY_POLICY } from '../lib/content-security-policy.ts';
import { DataStack } from '../lib/data-stack.ts';
import {
  COGNITO_ACTIONS,
  DYNAMODB_ACTIONS,
  KMS_SSM_API_ACTIONS,
  KMS_SSM_JOB_ACTIONS,
  SSM_API_ACTIONS,
  SSM_JOB_ACTIONS,
  CLIENT_IP_HEADER,
  FILE_SERVER_RETENTION_DAYS,
  ORIGIN_SECRET_READ_ACTION,
  S3_READ_ACTIONS,
  S3_WRITE_ACTION,
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
    // 画面のバケットと、ファイルサーバーのモックのバケット（Issue #77）の 2 つが、中身ごと削除される
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 2);
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

  it('画面のファイルは、2 つに分けて配置する。ハッシュ付きの assets/ は、長期のキャッシュ（immutable）、それ以外（index.html・sw.js・manifest）は、毎回、更新を確認する（no-cache）。Issue #323', () => {
    const { template } = plainStack();
    const deployments = Object.entries(
      template.findResources('Custom::CDKBucketDeployment') as Record<
        string,
        {
          DependsOn?: string[];
          Properties: {
            Exclude?: string[];
            Include?: string[];
            Prune?: boolean;
            DistributionPaths?: string[];
            SystemMetadata?: Record<string, string>;
          };
        }
      >,
    );

    expect(deployments).toHaveLength(2);
    const assets = deployments.find(([, deployment]) =>
      deployment.Properties.Include?.includes('assets/*'),
    );
    const rest = deployments.find(([, deployment]) =>
      deployment.Properties.Exclude?.includes('assets/*'),
    );
    expect(assets).toBeDefined();
    expect(rest).toBeDefined();
    // ハッシュ付きの部品: ファイル名が変わらない限り、内容は変わらない。長く、キャッシュしてよい
    expect(assets?.[1].Properties.Exclude).toEqual(['*']);
    expect(assets?.[1].Properties.Include).toEqual(['assets/*']);
    expect(assets?.[1].Properties.SystemMetadata?.['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    // index.html など: 毎回、更新を確認する（変わっていなければ、304）。古い index.html を使い続けない
    expect(rest?.[1].Properties.Include).toBeUndefined();
    expect(rest?.[1].Properties.SystemMetadata?.['cache-control']).toBe('no-cache');
    // 互いのファイルを、削除（prune）しない。キャッシュの無効化は、全ファイルを配置したあとの 1 回だけ
    expect(assets?.[1].Properties.Prune).toBe(true);
    expect(rest?.[1].Properties.Prune).toBe(true);
    expect(rest?.[1].Properties.DistributionPaths).toEqual(['/*']);
    expect(assets?.[1].Properties.DistributionPaths).toBeUndefined();
    // 新しい index.html は、新しい assets/ を配置したあとに、公開する（先に、index.html が新しくなって、部品がない時間を作らない）
    expect(rest?.[1].DependsOn).toContain(assets?.[0]);
  });
});

/** CSP のヘッダーの値を、ディレクティブ → 値の一覧にする。 */
function directivesOf(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name !== undefined && name !== '')
      .map(([name, ...values]) => [name ?? '', values] as const),
  );
}

describe('評価環境のスタック: 画面の配信ヘッダー（CSP・frame-ancestors。Issue #127）', () => {
  const SECURITY_HEADERS_POLICY_ID = '67f7725c-6f97-4210-82d7-5512b31e9d03';

  it('CSP は、画面が動く最小の許可（同じオリジンだけ）。スクリプトのインライン・eval を許さず、インラインのスタイルは、style 属性だけに限る。埋め込みは許さない', () => {
    const directives = directivesOf(STATIC_CONTENT_SECURITY_POLICY);

    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
    for (const name of ['img-src', 'font-src', 'connect-src', 'worker-src', 'manifest-src']) {
      expect(directives.get(name), name).toEqual(["'self'"]);
    }
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    // 'unsafe-inline' は style-src-attr だけ。'unsafe-eval'・外部のオリジン（http・https・*）は、どこにも許さない
    expect(STATIC_CONTENT_SECURITY_POLICY.match(/'unsafe-inline'/g)).toHaveLength(1);
    expect(STATIC_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval|https?:|\*/);
  });

  it('画面の配信に、独自の応答ヘッダーポリシー（CSP・X-Frame-Options DENY と、これまでのマネージドポリシーと同じヘッダー）を付ける', () => {
    const { template } = plainStack();

    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: {
            ContentSecurityPolicy: STATIC_CONTENT_SECURITY_POLICY,
            Override: true,
          },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: false,
            Preload: false,
            Override: true,
          },
          XSSProtection: { Protection: true, ModeBlock: true, Override: true },
        },
      }),
    });
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    expect(Object.keys(policies)).toHaveLength(1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: { Ref: Object.keys(policies)[0] },
        }),
      }),
    });
  });

  it('API（/api/*・/health）の応答は、これまでのマネージドポリシーのまま（API の CSP は、バックエンドが付ける）', () => {
    const { template } = plainStack();

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayEquals([
          Match.objectLike({
            PathPattern: '/api/*',
            ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
          }),
          Match.objectLike({
            PathPattern: '/health',
            ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
          }),
        ]),
      }),
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

  it('ログは、すべてのロググループで、30 日で自動削除し、スタックを消すと一緒に消す（画面の配置の補助の Lambda を含む。Issue #80）', () => {
    const { template } = plainStack();
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup')) as {
      DeletionPolicy?: string;
      Properties: { RetentionInDays?: number };
    }[];

    // API・ジョブ（Issue #76）・合成データの生成（Issue #77）・画面の配置（BucketDeployment）の補助の 4 つ。増えたときは、保持期間を絞り忘れていないか確認する
    expect(logGroups).toHaveLength(4);
    for (const logGroup of logGroups) {
      expect(logGroup.Properties.RetentionInDays).toBe(30);
      expect(logGroup.DeletionPolicy).toBe('Delete');
    }
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

/** 指定した Lambda のロールに付く、インラインのポリシーの文（画面の配置など、ほかのロールは、含めない）。 */
function roleStatements(template: Template, functionId = 'ApiFunction'): PolicyStatementJson[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { PolicyDocument: { Statement: PolicyStatementJson[] } } }
  >;
  return Object.entries(policies)
    .filter(([logicalId]) => logicalId.startsWith(`${functionId}ServiceRoleDefaultPolicy`))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

describe('評価環境のスタック: 関数の URL への直接の呼び出しの防止（秘密のヘッダー。Issue #102。ADR-0010）', () => {
  it('Secrets Manager に、秘密の値を自動生成する（英数字だけ・64 文字。名前は固定せず、スタックの作り直しで、衝突しない）。値は、リポジトリ・テンプレートに、書かない', () => {
    const { template } = plainStack();

    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ PasswordLength: 64, ExcludePunctuation: true }),
    });
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets[0]?.Properties.Name).toBeUndefined();
    expect(secrets[0]?.DeletionPolicy).toBe('Delete');
  });

  it('API のオリジン（関数の URL）にだけ、秘密のヘッダーを付ける。S3 のオリジンには、付けない', () => {
    const { template } = plainStack();
    const headers = new Capture();

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([Match.objectLike({ OriginCustomHeaders: headers })]),
      }),
    });

    expect(headers.asArray()).toEqual([
      { HeaderName: ORIGIN_SECRET_HEADER, HeaderValue: expect.anything() },
    ]);
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    const origins = distribution?.Properties.DistributionConfig.Origins as {
      OriginCustomHeaders?: unknown;
    }[];
    expect(origins.filter((origin) => origin.OriginCustomHeaders !== undefined)).toHaveLength(1);
    // /api/*・/health は、どちらも、このオリジンへ向ける
    expect(origins).toHaveLength(2);
  });

  it('API の Lambda の環境変数は、秘密の ARN だけ（ORIGIN_VERIFY_ARN。秘密の値は、持たない）。ジョブ・デモの Lambda には、持たせない。CloudFront のヘッダーは、動的な参照（リテラルでない）', () => {
    const { template } = plainStack();
    const environment = new Capture();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ORIGIN_VERIFY_ARN: environment }) },
    });
    const header = new Capture();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderValue: header })] }),
        ]),
      }),
    });

    const [secretId] = Object.keys(template.findResources('AWS::SecretsManager::Secret'));
    expect(environment.asObject()).toEqual({ Ref: secretId });
    // CloudFront のヘッダーだけが、秘密の値を、動的な参照で持つ。Lambda の環境変数には、値を持たない
    expect(JSON.stringify(header.asObject())).toContain('resolve:secretsmanager:');
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    for (const resource of functions) {
      const variables = (resource.Properties.Environment?.Variables ?? {}) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(variables)).not.toContain('resolve:secretsmanager');
      expect(variables.ORIGIN_VERIFY_SECRET).toBeUndefined();
    }
    const withArn = functions.filter(
      (resource) =>
        (resource.Properties.Environment?.Variables as Record<string, unknown> | undefined)
          ?.ORIGIN_VERIFY_ARN !== undefined,
    );
    expect(withArn).toHaveLength(1);
  });

  it('IAM: API の Lambda だけが、この秘密の GetSecretValue（読み取りのみ）を持つ。ジョブの Lambda は、持たない', () => {
    const { template } = plainStack();
    const [secretId] = Object.keys(template.findResources('AWS::SecretsManager::Secret'));
    const secretStatements = (functionId: string) =>
      roleStatements(template, functionId).filter((statement) =>
        [statement.Action].flat().some((action) => action.startsWith('secretsmanager:')),
      );

    const api = secretStatements('ApiFunction');
    expect(api).toHaveLength(1);
    expect(api[0]).toMatchObject({
      Action: ORIGIN_SECRET_READ_ACTION,
      Effect: 'Allow',
      Resource: { Ref: secretId },
    });
    expect(secretStatements('JobFunction')).toEqual([]);
  });
});

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

  it('API の環境変数: ログインの失敗の制限（接続元ごと）は、既定で、失敗 5 回 / 15 分。ジョブの Lambda には、持たない（Issue #244。D-44）', () => {
    const { template } = plainStack();
    const withSetting = Object.values(
      template.findResources('AWS::Lambda::Function') as Record<
        string,
        { Properties: { Environment?: { Variables: Record<string, unknown> } } }
      >,
    ).filter(
      (resource) => resource.Properties.Environment?.Variables.LOGIN_FAILURE_LIMIT !== undefined,
    );

    expect(environmentOf(template)).toMatchObject({
      LOGIN_FAILURE_LIMIT: '5',
      LOGIN_FAILURE_WINDOW_MINUTES: '15',
    });
    // 設定を持つのは、API（ログインを受ける関数）だけ
    expect(withSetting).toHaveLength(1);
    expect(withSetting[0]?.Properties.Environment?.Variables.CLIENT_IP_HEADER).toBe(
      CLIENT_IP_HEADER,
    );
  });

  it('API の環境変数: ログインの失敗の制限は、スタックの引数（デプロイ時の指定）で変えられる。コードの変更は、要らない（Issue #244）', () => {
    const app = newApp();
    const stack = new EvaluationStack(app, 'Evaluation', {
      frontendAssetPath: frontendAssets(),
      data: new DataStack(app, 'Data'),
      loginFailurePolicy: { limit: 10, windowMinutes: 30 },
    });

    expect(environmentOf(Template.fromStack(stack))).toMatchObject({
      LOGIN_FAILURE_LIMIT: '10',
      LOGIN_FAILURE_WINDOW_MINUTES: '30',
    });
  });

  it('API の環境変数 EVALUATION_ON_WRITE は deferred（手動入力の保存・削除の応答の前に、評価しない。Issue #123。ADR-0014）。ジョブの Lambda には、持たない', () => {
    const { template } = plainStack();
    const environment = environmentOf(template);
    const withSetting = Object.values(
      template.findResources('AWS::Lambda::Function') as Record<
        string,
        { Properties: { Environment?: { Variables: Record<string, unknown> } } }
      >,
    ).filter(
      (resource) => resource.Properties.Environment?.Variables.EVALUATION_ON_WRITE !== undefined,
    );

    expect(environment.EVALUATION_ON_WRITE).toBe('deferred');
    // 設定を持つのは、API（利用者の IP のヘッダーを持つ関数）だけ
    expect(withSetting).toHaveLength(1);
    expect(withSetting[0]?.Properties.Environment?.Variables.CLIENT_IP_HEADER).toBe(
      CLIENT_IP_HEADER,
    );
  });

  it('環境変数: 秘密情報の保管先は、パラメータストア（環境ごとのパスの接頭辞）。API とジョブの両方に、同じ設定を持つ（#206。D-55）', () => {
    const dev = plainStack();
    const app = newApp();
    const production = new EvaluationStack(app, 'Evaluation', {
      frontendAssetPath: frontendAssets(),
      data: new DataStack(app, 'Data'),
      siteEnvironment: 'production',
    });
    const functions = (template: Template) =>
      Object.values(
        template.findResources('AWS::Lambda::Function') as Record<
          string,
          { Properties: { Environment?: { Variables: Record<string, unknown> } } }
        >,
      ).filter((resource) => resource.Properties.Environment?.Variables.APP_MODE !== undefined);

    for (const resource of functions(dev.template)) {
      expect(resource.Properties.Environment?.Variables).toMatchObject({
        CREDENTIAL_STORE: 'ssm',
        CREDENTIAL_PATH_PREFIX: '/sfm/development/',
      });
    }
    const productionFunctions = functions(Template.fromStack(production));
    expect(productionFunctions).toHaveLength(2);
    for (const resource of productionFunctions) {
      expect(resource.Properties.Environment?.Variables).toMatchObject({
        CREDENTIAL_STORE: 'ssm',
        CREDENTIAL_PATH_PREFIX: '/sfm/production/',
      });
    }
  });

  it('IAM（API）: パラメータストアは、環境のパスの下だけ（読み取り・書き込み）。復号・暗号化は、SSM 経由の利用に限る。ワイルドカードの全リソースはない（#206）', () => {
    const { template } = plainStack();
    const statements = roleStatements(template);
    const actionsOf = (statement: PolicyStatementJson): string[] => [statement.Action].flat();
    const ssm = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('ssm:')),
    );
    const kms = statements.filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('kms:')),
    );

    expect(ssm).toHaveLength(1);
    expect(kms).toHaveLength(1);
    const [ssmStatement] = ssm;
    const [kmsStatement] = kms;
    if (ssmStatement === undefined || kmsStatement === undefined) {
      throw new Error('テストの前提');
    }
    expect(actionsOf(ssmStatement).sort()).toEqual([...SSM_API_ACTIONS].sort());
    expect(JSON.stringify(ssmStatement.Resource)).toContain('parameter/sfm/development/*');
    expect(actionsOf(kmsStatement).sort()).toEqual([...KMS_SSM_API_ACTIONS].sort());
    expect(JSON.stringify(kmsStatement)).toContain('kms:ViaService');
    expect(JSON.stringify(kmsStatement)).toContain('ssm.');
    for (const statement of statements) {
      expect(statement.Resource).not.toBe('*');
    }
  });

  it('IAM（ジョブ）: パラメータストアは、読み取りだけ。書き込み・削除はない（#206）', () => {
    const { template } = plainStack();
    const statements = roleStatements(template, 'JobFunction');
    const actions = statements.flatMap((statement) => [statement.Action].flat());

    expect(actions).toEqual(expect.arrayContaining([...SSM_JOB_ACTIONS, ...KMS_SSM_JOB_ACTIONS]));
    expect(actions.filter((action) => action.startsWith('ssm:'))).toEqual([...SSM_JOB_ACTIONS]);
    expect(actions).not.toContain('kms:Encrypt');
    expect(actions).not.toContain('kms:GenerateDataKey');
    const ssm = statements.find((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('ssm:')),
    );
    expect(JSON.stringify(ssm?.Resource)).toContain('parameter/sfm/development/*');
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
    const statements = roleStatements(template);
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

describe('評価環境のスタック: ジョブを EventBridge から Lambda で実行する（Issue #76。ADR-0011）', () => {
  interface FunctionJson {
    Type: string;
    Properties: {
      Handler?: string;
      Environment?: { Variables: Record<string, unknown> };
    };
  }

  function jobFunctionOf(template: Template): FunctionJson {
    const resources = template.findResources('AWS::Lambda::Function') as Record<
      string,
      FunctionJson
    >;
    const entry = Object.entries(resources).find(([logicalId]) =>
      logicalId.startsWith('JobFunction'),
    );
    if (entry === undefined) {
      throw new Error('ジョブの Lambda がありません');
    }
    return entry[1];
  }

  it('ジョブの Lambda は、Node.js 24・ARM・1024 MB で、タイムアウトはロックの期限より短い。Lambda の自動の再試行はしない', () => {
    const { template } = plainStack();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      Timeout: JOB_LAMBDA_TIMEOUT_SECONDS,
      Environment: Match.objectLike({
        Variables: Match.objectLike({ APP_MODE: 'production', PERSISTENCE: 'dynamodb' }),
      }),
    });
    // ロックの期限は、タイムアウトより長い（実行中に、期限が切れて、次の実行が始まらない）
    expect(JOB_LEASE_MS).toBeGreaterThan(JOB_LAMBDA_TIMEOUT_SECONDS * 1000);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });

  it('環境変数は、API と同じ本番の構成（ID・テーブル名は、データのスタックの出力）。秘密情報・開発用 API・利用者の IP のヘッダーはない', () => {
    const { template } = plainStack();
    const variables = jobFunctionOf(template).Properties.Environment?.Variables ?? {};

    expect(variables).toMatchObject({
      APP_MODE: 'production',
      PERSISTENCE: 'dynamodb',
      AUTH_PROVIDER: 'cognito',
      LOG_LEVEL: 'info',
    });
    for (const name of [
      'COGNITO_USER_POOL_ID',
      'DYNAMODB_OBSERVATIONS_TABLE',
      'DYNAMODB_MAIN_TABLE',
    ]) {
      expect(JSON.stringify(variables[name])).toContain('Fn::ImportValue');
    }
    const names = Object.keys(variables);
    expect(names.filter((name) => /SECRET|PASSWORD|TOKEN|KEY/i.test(name))).toEqual([]);
    for (const name of ['CLIENT_IP_HEADER', 'DEV_API_ENABLED', 'SEED_MODE', 'SCHEDULER_ENABLED']) {
      expect(names).not.toContain(name);
    }
  });

  it('EventBridge のルールは、既定の実行間隔（4 種）ごと。入力は、jobId。再試行はせず、古いイベントは捨てる', () => {
    const { template } = plainStack();
    const rules = Object.values(template.findResources('AWS::Events::Rule')) as {
      Properties: {
        ScheduleExpression: string;
        State: string;
        Targets: {
          Input?: string;
          RetryPolicy: { MaximumRetryAttempts: number; MaximumEventAgeInSeconds: number };
        }[];
      };
    }[];

    // ジョブのルール（入力に jobId を持つ）の数。合成データの生成のルール（入力なし）は、別のテストで確かめる
    const jobRules = rules.filter((rule) =>
      rule.Properties.Targets.some((target) => target.Input !== undefined),
    );
    expect(jobRules).toHaveLength(DEFAULT_SCHEDULE.length);
    for (const plan of DEFAULT_SCHEDULE) {
      const expression =
        plan.intervalMinutes === 1
          ? 'rate(1 minute)'
          : `rate(${String(plan.intervalMinutes)} minutes)`;
      const matched = jobRules.filter(
        (rule) =>
          rule.Properties.ScheduleExpression === expression &&
          rule.Properties.Targets.some(
            (target) => target.Input === JSON.stringify({ jobId: plan.jobId }),
          ),
      );
      expect(matched, plan.jobId).toHaveLength(1);
      expect(matched[0]?.Properties.State).toBe('ENABLED');
      expect(matched[0]?.Properties.Targets[0]?.RetryPolicy).toEqual({
        MaximumRetryAttempts: 0,
        MaximumEventAgeInSeconds: 60,
      });
    }
    // EventBridge が、ジョブの Lambda を呼び出す権限（ルールごと。合成データを生成する Lambda の権限は、含めない）
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as {
      Properties: { Principal: string; Action: string; FunctionName: unknown };
    }[];
    expect(
      permissions.filter(
        (permission) =>
          permission.Properties.Principal === 'events.amazonaws.com' &&
          permission.Properties.Action === 'lambda:InvokeFunction' &&
          JSON.stringify(permission.Properties.FunctionName).includes('JobFunction'),
      ),
    ).toHaveLength(DEFAULT_SCHEDULE.length);
  });

  it('IAM は最小権限: DynamoDB の 2 テーブル（インデックスを含む）への、必要な操作と、ファイルサーバーのモックの読み取りだけ。Cognito の権限・ワイルドカードのリソースはない', () => {
    const { template } = plainStack();
    const statements = roleStatements(template, 'JobFunction');
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    const dynamodb = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith('dynamodb:')),
    );

    // 許可する操作は、DynamoDB の必要な操作と、ファイルサーバーのモックの読み取りと、秘密情報（パラメータストア）の読み取り・復号だけ
    // （Cognito・書き込み・削除はない。パラメータストアの書き込みは、API だけ。#206）
    expect(actions.sort()).toEqual(
      [...DYNAMODB_ACTIONS, ...S3_READ_ACTIONS, ...SSM_JOB_ACTIONS, ...KMS_SSM_JOB_ACTIONS].sort(),
    );
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('ssm:PutParameter');
    expect(statements).toHaveLength(5);
    expect(dynamodb).toHaveLength(1);
    expect(dynamodb[0]?.Resource).toHaveLength(4);
    for (const statement of statements) {
      expect(statement.Resource).not.toBe('*');
    }
  });

  it('ジョブの Lambda の関数名を出力する（動作の確認で、ログを探すため）', () => {
    const { template } = plainStack();
    template.hasOutput('JobFunctionName', {});
  });
});

describe('評価環境のスタック: ファイルサーバーのモックの S3（Issue #77。ADR-0012）', () => {
  interface BucketJson {
    Properties: {
      PublicAccessBlockConfiguration?: Record<string, boolean>;
      BucketEncryption?: unknown;
      LifecycleConfiguration?: { Rules: { ExpirationInDays?: number; Status: string }[] };
    };
    DeletionPolicy?: string;
  }

  function fileServerBucket(template: Template): BucketJson {
    const buckets = template.findResources('AWS::S3::Bucket') as Record<string, BucketJson>;
    const entry = Object.entries(buckets).find(([logicalId]) =>
      logicalId.startsWith('FileServerBucket'),
    );
    if (entry === undefined) {
      throw new Error('ファイルサーバーのモックのバケットがありません');
    }
    return entry[1];
  }

  it('バケットは、非公開・暗号化・SSL 強制で、ファイルを一定の日数で自動で消し、評価環境と一緒に消える', () => {
    const { template } = plainStack();
    const bucket = fileServerBucket(template);

    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.BucketEncryption).toBeDefined();
    expect(bucket.Properties.LifecycleConfiguration?.Rules).toEqual([
      { ExpirationInDays: FILE_SERVER_RETENTION_DAYS, Status: 'Enabled' },
    ]);
    expect(bucket.DeletionPolicy).toBe('Delete');
    // SSL を強制するバケットポリシー（FileServerBucket 用）がある
    const policies = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toContain('aws:SecureTransport');
  });

  it('API・ジョブの Lambda は、このバケットだけを、読み取りだけできる（書き込み・削除・ワイルドカードの権限はない）。バケット名は、環境変数で渡す', () => {
    const { template } = plainStack();

    for (const functionId of ['ApiFunction', 'JobFunction']) {
      const statements = roleStatements(template, functionId).filter((statement) =>
        [statement.Action].flat().some((action) => action.startsWith('s3:')),
      );
      expect(statements.map((statement) => [statement.Action].flat())).toEqual([
        ['s3:ListBucket'],
        ['s3:GetObject'],
      ]);
      for (const statement of statements) {
        expect(JSON.stringify(statement.Resource)).toContain('FileServerBucket');
        expect(statement.Resource).not.toBe('*');
      }
    }
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties: { Environment?: { Variables: Record<string, unknown> } } }
    >;
    const withBucket = Object.values(resources).filter(
      (resource) =>
        resource.Type === 'AWS::Lambda::Function' &&
        JSON.stringify(
          resource.Properties.Environment?.Variables.FILE_SERVER_S3_BUCKET ?? '',
        ).includes('FileServerBucket'),
    );
    // API・ジョブ・合成データを生成する 3 つの関数
    expect(withBucket).toHaveLength(3);
  });

  it('API・ジョブの Lambda の、S3 の権限は、読み取りだけ（合成データを生成する Lambda の書き込みと、混ざらない）', () => {
    const { template } = plainStack();

    for (const functionId of ['ApiFunction', 'JobFunction']) {
      const actions = roleStatements(template, functionId).flatMap((statement) =>
        [statement.Action].flat(),
      );
      expect(actions).not.toContain(S3_WRITE_ACTION);
    }
  });

  it('バケット名を出力する（デモデータの確認・手順で、探すため）', () => {
    const { template } = plainStack();
    template.hasOutput('FileServerBucketName', {});
  });
});

describe('評価環境のスタック: 合成データを定期的に生成する（擬似のロボット・環境センサー。Issue #77。ADR-0012）', () => {
  interface FunctionJson {
    Properties: { Environment?: { Variables: Record<string, unknown> } };
  }

  function demoFeedFunction(template: Template): FunctionJson {
    const resources = template.findResources('AWS::Lambda::Function') as Record<
      string,
      FunctionJson
    >;
    const entry = Object.entries(resources).find(([logicalId]) =>
      logicalId.startsWith('DemoFeedFunction'),
    );
    if (entry === undefined) {
      throw new Error('合成データを生成する Lambda がありません');
    }
    return entry[1];
  }

  it('関数は、Node.js 24・ARM・小さいメモリで、タイムアウトは短い。Lambda の自動の再試行はしない。環境変数は、バケット名だけ', () => {
    const { template } = plainStack();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: DEMO_FEED_TIMEOUT_SECONDS,
      Environment: { Variables: { FILE_SERVER_S3_BUCKET: Match.anyValue() } },
    });
    const variables = demoFeedFunction(template).Properties.Environment?.Variables ?? {};
    // DynamoDB・Cognito・本番の組み立てに使う設定は、持たない（S3 への書き込みだけ）
    expect(Object.keys(variables)).toEqual(['FILE_SERVER_S3_BUCKET']);
    expect(JSON.stringify(variables.FILE_SERVER_S3_BUCKET)).toContain('FileServerBucket');
  });

  it('IAM は最小権限: ファイルサーバーのモックの取り込み元の下（robot・environment-sensor）への、書き込みだけ。読み取り・削除・DynamoDB・ワイルドカードはない', () => {
    const { template } = plainStack();
    const statements = roleStatements(template, 'DemoFeedFunction');

    expect(statements).toHaveLength(1);
    expect([statements[0]?.Action].flat()).toEqual([S3_WRITE_ACTION]);
    expect(statements[0]?.Resource).toHaveLength(DEMO_FEED_SOURCE_IDS.length);
    for (const sourceId of DEMO_FEED_SOURCE_IDS) {
      expect(JSON.stringify(statements[0]?.Resource)).toContain(`/${sourceId}/*`);
    }
    expect(statements[0]?.Resource).not.toBe('*');
  });

  it('EventBridge のルールは、15 分ごと。入力なし。再試行はせず、古いイベントは捨てる。呼び出しの権限がある', () => {
    const { template } = plainStack();

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: `rate(${String(DEMO_FEED_INTERVAL_MINUTES)} minutes)`,
      State: 'ENABLED',
      Targets: [
        Match.objectLike({
          Input: Match.absent(),
          RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
        }),
      ],
    });
  });

  it('関数名を出力する（動作の確認で、ログを探すため）', () => {
    const { template } = plainStack();
    template.hasOutput('DemoFeedFunctionName', {});
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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { describe, expect, it } from 'vitest';
import { EvaluationStack, SPA_REWRITE_CODE } from '../lib/evaluation-stack.ts';

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
  const stack = new EvaluationStack(newApp(), 'Evaluation', {
    frontendAssetPath: frontendAssets(),
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
      FunctionAssociations: Match.absent(),
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

  it('関数は、Node.js 24・ARM・10 秒で、ログの保持期間を絞る', () => {
    const { template } = plainStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 10,
      MemorySize: 256,
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
    expect(
      () =>
        new EvaluationStack(newApp(), 'Evaluation', {
          frontendAssetPath: frontendAssets(),
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
          domainName: 'eval.other.net',
          hostedZoneName: 'example.com',
          certificate: dummyCertificate(app),
        }),
    ).toThrow('サブドメイン');
  });
});

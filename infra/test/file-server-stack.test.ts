/**
 * 自前のファイルサーバーのスタック（Issue #298。ADR-0027）のテスト。S3 のバケット・Lambda（Function URL）・権限・環境ごとの違いを確かめる。
 * Lambda のコードのまとめ（esbuild）は省く（bundle-lambda.test.ts で確認する）。実際の AWS には、接続しない。
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY,
  FILE_SERVER_TIMEOUT_SECONDS,
  FileServerStack,
  type FileServerStackProps,
} from '../lib/file-server-stack.ts';

const ENV = { account: '111111111111', region: 'ap-northeast-1' } as const;

function build(props: FileServerStackProps = {}) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new FileServerStack(app, 'FileServer', { env: ENV, ...props });
  return { stack, template: Template.fromStack(stack) };
}

interface StatementJson {
  Action: string | string[];
  Effect: string;
  Resource: unknown;
  Condition?: unknown;
}

/** 関数の実行ロールに付く、追加の権限（基本のログの権限は、含まれない）。 */
function roleStatements(template: Template): StatementJson[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { PolicyDocument: { Statement: StatementJson[] } } }
  >;
  return Object.entries(policies)
    .filter(([logicalId]) =>
      logicalId.startsWith('HostedFileServerFunctionServiceRoleDefaultPolicy'),
    )
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: StatementJson): string[] => [statement.Action].flat();

describe('自前のファイルサーバーのスタック: S3 のバケット', () => {
  it('非公開（パブリックアクセスをすべてブロック）・サーバー側の暗号化（SSE-S3）・SSL 以外を拒否する。バージョニングはしない（履歴は、取り込みが積み上げる）', () => {
    const { template } = build();

    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
        ],
      },
    });
    const bucket = Object.values(
      template.findResources('AWS::S3::Bucket') as Record<
        string,
        { Properties: { VersioningConfiguration?: unknown } }
      >,
    )[0];
    expect(bucket?.Properties.VersioningConfiguration).toBeUndefined();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('開発サイト: スタックを消すと、バケットも消える（中身ごと）。削除の保護は、ない', () => {
    const { stack, template } = build({ siteEnvironment: 'development' });

    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    expect(stack.terminationProtection).toBe(false);
  });

  it('本番サイト: スタックを消しても、バケットは残す（RETAIN。中身を自動で消さない）。スタックの削除の保護を、有効にする', () => {
    const { stack, template } = build({ siteEnvironment: 'production' });

    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    expect(stack.terminationProtection).toBe(true);
  });
});

describe('自前のファイルサーバーのスタック: Lambda と Function URL', () => {
  it('Node.js 24・ARM・256MB で、タイムアウトは短い。環境変数は、バケット名・パスの接頭辞・ログの水準だけ（トークンの値を持たない）', () => {
    const { template } = build();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: FILE_SERVER_TIMEOUT_SECONDS,
      Handler: 'index.handler',
    });
    // 開発サイトは、バケットの自動削除の、CDK のカスタムリソースの Lambda も持つ。ファイルサーバーの関数だけを選ぶ
    const functions = Object.entries(
      template.findResources('AWS::Lambda::Function') as Record<
        string,
        { Properties: { Environment?: { Variables: Record<string, unknown> } } }
      >,
    ).filter(([logicalId]) => logicalId.startsWith('HostedFileServerFunction'));
    expect(functions).toHaveLength(1);
    const variables = functions[0]?.[1].Properties.Environment?.Variables ?? {};
    expect(Object.keys(variables).sort()).toEqual([
      'CREDENTIAL_PATH_PREFIX',
      'HOSTED_FILE_SERVER_BUCKET',
      'LOG_LEVEL',
    ]);
    expect(variables.CREDENTIAL_PATH_PREFIX).toBe('/sfm/development/');
    expect(JSON.stringify(variables.HOSTED_FILE_SERVER_BUCKET)).toContain('Ref');
  });

  it('秘密情報のパスの接頭辞は、環境ごとに分ける（開発 /sfm/development/・本番 /sfm/production/）。IAM のリソースにも、入る', () => {
    const development = JSON.stringify(build({ siteEnvironment: 'development' }).template.toJSON());
    const production = JSON.stringify(build({ siteEnvironment: 'production' }).template.toJSON());

    expect(development).toContain('/sfm/development/');
    expect(development).not.toContain('/sfm/production/');
    expect(production).toContain('/sfm/production/');
    expect(production).not.toContain('/sfm/development/');
  });

  it('同時実行数の上限を付ける（費用の増加の対策。既定は 10。指定で変えられる）', () => {
    const defaults = build().template;
    const specified = build({ reservedConcurrency: 3 }).template;

    defaults.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY,
    });
    expect(FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY).toBe(10);
    specified.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 3,
    });
  });

  it('Function URL は、URL 自体は認証なし（アプリが、トークンで認証する）。この関数だけに向き、呼び出しの許可も、この関数だけ', () => {
    const { template } = build();

    template.resourceCountIs('AWS::Lambda::Url', 1);
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    const permissions = Object.values(
      template.findResources('AWS::Lambda::Permission', {
        Properties: { Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'NONE' },
      }) as Record<string, { Properties: { FunctionName: unknown } }>,
    );
    expect(permissions).toHaveLength(1);
    expect(JSON.stringify(permissions[0]?.Properties.FunctionName)).toContain(
      'HostedFileServerFunction',
    );
  });

  it('ログは、30 日で自動削除する', () => {
    const { template } = build();

    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });
});

describe('自前のファイルサーバーのスタック: 権限（最小権限）', () => {
  it('バケットの `files/` の下の GetObject・PutObject と、バケットの ListBucket（ファイルなしを 404 にするため）、トークンのパラメータストアの読み出し（この機能のパスだけ）と復号だけ', () => {
    const { template } = build();

    const statements = roleStatements(template);

    const actions = statements.flatMap(actionsOf).sort();
    expect(actions).toEqual([
      'kms:Decrypt',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
      'ssm:GetParameter',
    ]);
    const objects = statements.find((statement) => actionsOf(statement).includes('s3:PutObject'));
    expect(objects === undefined ? undefined : actionsOf(objects).sort()).toEqual([
      's3:GetObject',
      's3:PutObject',
    ]);
    expect(JSON.stringify(objects?.Resource)).toContain('/files/*');
    const list = statements.find((statement) => actionsOf(statement).includes('s3:ListBucket'));
    expect(JSON.stringify(list?.Resource)).not.toContain('/*');
    const parameter = statements.find((statement) =>
      actionsOf(statement).includes('ssm:GetParameter'),
    );
    expect(JSON.stringify(parameter?.Resource)).toContain(
      'parameter/sfm/development/hosted-file-server/*',
    );
    // 復号は、パラメータストア経由に限る
    const decrypt = statements.find((statement) => actionsOf(statement).includes('kms:Decrypt'));
    expect(decrypt?.Condition).toEqual({
      StringEquals: { 'kms:ViaService': 'ssm.ap-northeast-1.amazonaws.com' },
    });
  });

  it('削除・書き込み以外の S3 の操作・DynamoDB・Cognito・Secrets Manager の権限を、付けない。「すべて」のリソース（*）は、暗号化の鍵（パラメータストア経由に限る）だけ', () => {
    const { template } = build();

    const statements = roleStatements(template);
    const json = JSON.stringify(statements);

    for (const forbidden of ['s3:Delete', 's3:*', 'dynamodb:', 'cognito-idp:', 'secretsmanager:']) {
      expect(json).not.toContain(forbidden);
    }
    const wildcard = statements.filter((statement) => statement.Resource === '*');
    expect(wildcard).toEqual([]);
  });
});

describe('自前のファイルサーバーのスタック: 独立と出力', () => {
  it('評価環境・データのリソース（CloudFront・DynamoDB・Cognito・EventBridge）を、持たない（独立したスタック）', () => {
    const { template } = build();
    const types = Object.values(
      (template.toJSON() as { Resources: Record<string, { Type: string }> }).Resources,
    ).map((resource) => resource.Type);

    for (const type of types) {
      expect(type).not.toMatch(/^AWS::(CloudFront|DynamoDB|Cognito|Events)::/);
    }
  });

  it('URL・バケット名・関数名を出力する（運用者が、ロボットの設定・手動の配置・ログの確認に使う）。URL の値は、テンプレートに書かない（デプロイ時に決まる）', () => {
    const { template } = build();

    template.hasOutput('HostedFileServerUrl', {});
    template.hasOutput('HostedFileServerBucketName', {});
    template.hasOutput('HostedFileServerFunctionName', {});
    const outputs = (template.toJSON() as { Outputs: Record<string, { Value: unknown }> }).Outputs;
    expect(JSON.stringify(outputs.HostedFileServerUrl?.Value)).toContain('FunctionUrl');
  });
});

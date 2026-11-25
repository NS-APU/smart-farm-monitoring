/**
 * 自前のファイルサーバーのスタック（Issue #298。ADR-0027）。ロボットが `PUT` で置いたファイルを、取り込み（JB-01）が `GET`・`HEAD` で読む。
 * ファイルの保管は S3 のバケット、読み書きの仲介は専用の Lambda（Function URL）。トークン（読み取り用・書き込み用）の認証は、アプリが行う。
 *
 * 評価環境のスタック（EvaluationStack）・データのスタック（DataStack）とは別にする（独立したスタック）。Function URL のホストは、関数を
 * 作り直すと変わるため、ロボット側に設定する URL が、評価環境の再作成・変更に巻き込まれないようにする。
 * - バケット: 非公開（パブリックアクセスをすべてブロック）・SSE-S3・SSL 以外を拒否。バージョニングなし（履歴は、取り込みが積み上げる）。
 *   開発サイト: スタックの削除で、中身ごと消える。**本番サイト: RETAIN（スタックを消しても残す）・スタックの削除の保護**（実データが入る）
 * - Lambda: Node.js 24・ARM・256MB・タイムアウト 10 秒。**同時実行数の上限**を付ける（認証に失敗するリクエストも、呼び出しの費用がかかる。
 *   費用の増加の対策。既定は 10）。ログは 30 日で自動削除
 * - 権限（最小）: バケットの `files/` の下の `GetObject`・`PutObject`、バケットの `ListBucket`（ないと、ファイルなしが 403 になり、404 を判定できない）、
 *   トークン（パラメータストア。この機能のパスだけ）の読み出しと、その復号（パラメータストア経由に限る）。DynamoDB・Cognito は、使わない
 * - トークンの値は、IaC・環境変数に持たない。運用者が、パラメータストアに登録する（手順は、operations.md）
 */

import { join } from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';
import { bundledLambdaCode } from './bundle-lambda.ts';
import { DEFAULT_SITE_ENVIRONMENT, type SiteEnvironment } from './config.ts';
import { KMS_SSM_JOB_ACTIONS, SSM_JOB_ACTIONS } from './evaluation-stack.ts';

/** 関数の同時実行数の上限の既定（費用の増加の対策。ADR-0027）。 */
export const FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY = 10;
/** 関数のタイムアウト（秒）。ファイル 1 つ（1 MiB まで）の読み書きだけのため、短い。 */
export const FILE_SERVER_TIMEOUT_SECONDS = 10;
const FILE_SERVER_MEMORY_MB = 256;
/** バケットの中の、ファイルを置く階層（`infrastructure/s3/s3-hosted-file-store.ts` の `files` と同じ）。 */
const FILES_PREFIX = 'files';
/** トークンのパラメータストアの、環境のパスの下の階層（`application/hosted-file-server/` の参照名と同じ）。 */
const TOKEN_PATH = 'hosted-file-server/';

export interface FileServerStackProps extends StackProps {
  /** サイトの環境（既定は development）。トークンのパスの接頭辞（`/sfm/<環境>/`）・削除の扱いが変わる。 */
  readonly siteEnvironment?: SiteEnvironment;
  /** 関数の同時実行数の上限。既定は、`FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY`。 */
  readonly reservedConcurrency?: number;
}

export class FileServerStack extends Stack {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: FileServerStackProps = {}) {
    const {
      siteEnvironment = DEFAULT_SITE_ENVIRONMENT,
      reservedConcurrency,
      ...stackProps
    } = props;
    const isProduction = siteEnvironment === 'production';
    super(scope, id, { terminationProtection: isProduction, ...stackProps });

    this.bucket = new Bucket(this, 'FileBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
    });

    const credentialPathPrefix = `/sfm/${siteEnvironment}/`;
    const fileServerFunction = new LambdaFunction(this, 'HostedFileServerFunction', {
      code: bundledLambdaCode(
        join(import.meta.dirname, '../../src/backend/runtime/hosted-file-server-lambda.ts'),
      ),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: FILE_SERVER_MEMORY_MB,
      timeout: Duration.seconds(FILE_SERVER_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: reservedConcurrency ?? FILE_SERVER_DEFAULT_RESERVED_CONCURRENCY,
      // 値は、バケット名・パスの名前で、秘密情報ではない。トークンの値は、環境変数に持たない（パラメータストアから読む）
      environment: {
        HOSTED_FILE_SERVER_BUCKET: this.bucket.bucketName,
        CREDENTIAL_PATH_PREFIX: credentialPathPrefix,
        LOG_LEVEL: 'info',
      },
      logGroup: new LogGroup(this, 'HostedFileServerLogGroup', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // バケット: `files/` の下の読み書きだけ（削除・一覧・ほかの操作は、付けない）。ListBucket は、ファイルなしを 404 にするために必要
    fileServerFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [this.bucket.arnForObjects(`${FILES_PREFIX}/*`)],
      }),
    );
    fileServerFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.bucket.bucketArn] }),
    );
    // トークン（パラメータストア）: この機能のパスの下だけ。暗号化の鍵（AWS の管理の鍵）は、パラメータストア経由の利用に限る
    fileServerFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [...SSM_JOB_ACTIONS],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `${credentialPathPrefix.slice(1)}${TOKEN_PATH}*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    fileServerFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [...KMS_SSM_JOB_ACTIONS],
        resources: [
          this.formatArn({
            service: 'kms',
            resource: 'key',
            resourceName: '*',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    // URL 自体は、認証なし（公開の URL）。トークンの認証は、アプリが行う。呼び出しの許可は、この関数だけ
    const fileServerUrl = fileServerFunction.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    new CfnOutput(this, 'HostedFileServerUrl', {
      value: fileServerUrl.url,
      description:
        '自前のファイルサーバーの URL（ロボットの PUT の宛先。設備ごとの接続のホストに指定する。リポジトリ・Issue・PR に書かない。ADR-0027）',
    });
    new CfnOutput(this, 'HostedFileServerBucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'HostedFileServerFunctionName', { value: fileServerFunction.functionName });
  }
}

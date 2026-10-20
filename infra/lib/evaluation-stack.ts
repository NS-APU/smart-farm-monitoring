/**
 * 顧客評価環境（サーバーレス構成）のスタック。Issue #71。
 *
 *   ブラウザ → CloudFront（独自サブドメイン + ACM の証明書。指定がなければ cloudfront.net）
 *                ├─ /*               → S3（画面の SPA。OAC でバケットを非公開にする）
 *                └─ /api/*・/health  → Lambda の関数の URL（API）
 *
 * - 画面と API を同じオリジンにする（CORS が不要。`/api/v1` の相対パスのまま動く）
 * - 関数の URL は、認証なし（NONE）にする。API の認証は、アプリ側（Issue #74 の Cognito）で行う。
 *   CloudFront の OAC で関数の URL を保護すると、POST・PUT の本文のハッシュ計算が必要になり、画面の POST と合わないため
 * - SPA の深いパス（/viewpoints/xxx など）は、CloudFront Function で index.html へ書き換える。
 *   CloudFront のエラー応答（403・404 → index.html）は、API の 403・404 まで書き換えるため、使わない
 * - 評価環境は、いつでも削除・再作成できる（バケットは、削除時に中身ごと削除する。データは、まだ持たない）
 * - API は、バックエンド本体の Lambda（src/backend/runtime/lambda.ts。Issue #75。ADR-0009）。DynamoDB のテーブルと Cognito の
 *   ユーザープールは、別のスタック（data-stack.ts。Issue #73・#74）にあり、ここから、環境変数と、最小権限の IAM で使う。
 *   EventBridge からのジョブの起動は、Issue #76
 */

import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  Architecture,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { RetentionDays, LogGroup } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { type Construct } from 'constructs';
import { bundledLambdaCode } from './bundle-lambda.ts';

/** ファイルの拡張子がないパス（SPA の画面のパス）を、index.html に書き換える。API のパスには、付けない。 */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

/** API が使う、データのリソース（data-stack.ts の DataStack）。 */
export interface ApiDataResources {
  readonly observationsTable: ITable;
  readonly mainTable: ITable;
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
}

/** API の Lambda が、DynamoDB に使う操作（Scan は使わない。トランザクションは、各項目の操作の権限で足りる）。 */
export const DYNAMODB_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:BatchGetItem',
  'dynamodb:Query',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:ConditionCheckItem',
] as const;

/**
 * API の Lambda が、Cognito に使う管理の操作（ユーザープールに限る。ADR-0008）。`GetUser`・`GlobalSignOut` は、
 * アクセストークンで認可される API のため、IAM の権限は、不要。
 */
export const COGNITO_ACTIONS = [
  'cognito-idp:AdminInitiateAuth',
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminSetUserPassword',
  'cognito-idp:AdminDeleteUser',
  'cognito-idp:AdminUserGlobalSignOut',
] as const;

/**
 * CloudFront と関数の URL を経由したとき、`X-Forwarded-For` の末尾から数えて、何番目が利用者の IP か（V-007）。
 * 末尾は、関数の URL が付ける、CloudFront の IP。その 1 つ前が、CloudFront が付ける、利用者の IP。
 * **仮の値。AWS で、CloudWatch のログインのログの接続元が、利用者の IP になることを確認する**（Issue #75）。
 */
export const TRUSTED_PROXY_HOPS = '2';

export interface EvaluationStackProps extends StackProps {
  /** API が使う、データのリソース（DynamoDB・Cognito）。 */
  readonly data: ApiDataResources;
  /** ビルドした画面（`pnpm build` の出力。dist/frontend）のディレクトリ。 */
  readonly frontendAssetPath: string;
  /** 独自のサブドメイン（例: evaluation.example.com）。指定しなければ、cloudfront.net のドメインを使う。 */
  readonly domainName?: string;
  /** ドメインを管理している Route 53 のホストゾーン名（例: example.com）。domainName を指定するとき、必須。 */
  readonly hostedZoneName?: string;
  /** CloudFront 用の証明書（us-east-1）。domainName を指定するとき、必須。 */
  readonly certificate?: ICertificate;
}

export class EvaluationStack extends Stack {
  /** 画面と API を公開する URL。 */
  readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: EvaluationStackProps) {
    super(scope, id, props);
    const { domainName, hostedZoneName, certificate } = props;
    if (domainName !== undefined && (hostedZoneName === undefined || certificate === undefined)) {
      throw new Error(
        'domainName を指定するときは、hostedZoneName と certificate も指定してください',
      );
    }
    if (
      domainName !== undefined &&
      hostedZoneName !== undefined &&
      !domainName.endsWith(hostedZoneName)
    ) {
      throw new Error('domainName は、hostedZoneName のサブドメインにしてください');
    }

    const siteBucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // API（バックエンド本体。Issue #75）。ログの保持期間を絞る（費用。NFR-1.5・NFR-6.3）。
    // メモリ・タイムアウトは、初期値（Issue #79 の実測で調整する）: CPU はメモリに比例するため 1024 MB、
    // タイムアウトは、CloudFront のオリジンの応答の上限（30 秒）の内側
    const { data } = props;
    const apiFunction = new LambdaFunction(this, 'ApiFunction', {
      code: bundledLambdaCode(join(import.meta.dirname, '../../src/backend/runtime/lambda.ts')),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(29),
      environment: {
        APP_MODE: 'production',
        PERSISTENCE: 'dynamodb',
        AUTH_PROVIDER: 'cognito',
        // 秘密情報ではない（ID・テーブル名）。値は、データのスタックの出力から取る（リポジトリに ID を書かない）
        COGNITO_USER_POOL_ID: data.userPool.userPoolId,
        COGNITO_CLIENT_ID: data.userPoolClient.userPoolClientId,
        DYNAMODB_OBSERVATIONS_TABLE: data.observationsTable.tableName,
        DYNAMODB_MAIN_TABLE: data.mainTable.tableName,
        TRUSTED_PROXY_HOPS,
        LOG_LEVEL: 'info',
      },
      logGroup: new LogGroup(this, 'ApiLogGroup', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // 最小権限: 2 つのテーブル（インデックスを含む）への、必要な操作だけ。Cognito は、ユーザープールに限る
    apiFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [...DYNAMODB_ACTIONS],
        resources: [data.observationsTable, data.mainTable].flatMap((table) => [
          table.tableArn,
          `${table.tableArn}/index/*`,
        ]),
      }),
    );
    apiFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [...COGNITO_ACTIONS],
        resources: [data.userPool.userPoolArn],
      }),
    );
    const apiUrl = apiFunction.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    const spaRewrite = new CloudFrontFunction(this, 'SpaRewrite', {
      code: FunctionCode.fromInline(SPA_REWRITE_CODE),
      runtime: FunctionRuntime.JS_2_0,
    });
    const apiBehavior = {
      origin: new FunctionUrlOrigin(apiUrl),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      // Authorization ヘッダー・クエリを、オリジンへ渡す（Host は、関数の URL のものを使う）
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
    };
    const distribution = new Distribution(this, 'Distribution', {
      comment: 'smart-farm-monitoring evaluation environment',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: { '/api/*': apiBehavior, '/health': apiBehavior },
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_200,
      ...(domainName === undefined || certificate === undefined
        ? {}
        : {
            domainNames: [domainName],
            certificate,
            // 独自の証明書があるときだけ、最低の TLS のバージョンを指定できる（cloudfront.net の証明書は、AWS の既定で固定）
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
          }),
    });

    // 画面のファイルを配置し、CloudFront のキャッシュを無効化する（デプロイのたびに、最新の画面になる）
    new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(props.frontendAssetPath)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    if (domainName !== undefined && hostedZoneName !== undefined) {
      const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: hostedZoneName });
      const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
      new ARecord(this, 'AliasRecord', { zone, recordName: domainName, target });
      new AaaaRecord(this, 'AliasRecordIpv6', { zone, recordName: domainName, target });
    }

    this.siteUrl = `https://${domainName ?? distribution.distributionDomainName}`;
    new CfnOutput(this, 'SiteUrl', { value: this.siteUrl, description: '評価環境の URL' });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ApiFunctionName', { value: apiFunction.functionName });
  }
}

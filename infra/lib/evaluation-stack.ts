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
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
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
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { type Construct } from 'constructs';
import {
  DEMO_FEED_INTERVAL_MINUTES,
  DEMO_FEED_SOURCE_IDS,
  DEMO_FEED_TIMEOUT_SECONDS,
} from '../../src/backend/application/demo/demo-feed-schedule.ts';
import {
  DEFAULT_SCHEDULE,
  JOB_LAMBDA_TIMEOUT_SECONDS,
} from '../../src/backend/application/jobs/job-schedule.ts';
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MINUTES,
  type LoginFailurePolicy,
} from '../../src/backend/infrastructure/common/auth-policy.ts';
import { DEFAULT_SITE_ENVIRONMENT, type SiteEnvironment } from './config.ts';
import { bundledLambdaCode } from './bundle-lambda.ts';
import { STATIC_CONTENT_SECURITY_POLICY } from './content-security-policy.ts';

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
 * 秘密情報（接続先の認証情報・Web Push の秘密鍵。パラメータストアの SecureString）に使う操作（Issue #206。ADR-0016 の D-55）。
 * 環境ごとのパス（`/sfm/<環境>/`）の下だけ。API の Lambda（画面の登録・接続テスト）は、読み取りと書き込み。
 * ジョブの Lambda（取り込み・連携）は、読み取りだけ。削除は、どちらにも付けない。
 */
export const SSM_API_ACTIONS = ['ssm:GetParameter', 'ssm:PutParameter'] as const;
export const SSM_JOB_ACTIONS = ['ssm:GetParameter'] as const;
/**
 * パラメータストアの暗号化（AWS の管理の鍵）に使う操作。パラメータストア経由（kms:ViaService）の利用に限る。
 * API は、復号と暗号化（書き込み）。ジョブは、復号だけ。
 */
export const KMS_SSM_API_ACTIONS = ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'] as const;
export const KMS_SSM_JOB_ACTIONS = ['kms:Decrypt'] as const;

/** ファイルサーバーのモックのバケットの、ファイルの保持日数（合成データのファイル。古いファイルは、取り込みの対象に、残さない）。 */
export const FILE_SERVER_RETENTION_DAYS = 3;

/** API・ジョブの Lambda が、ファイルサーバーのモックの S3 に使う操作（読み取りのみ。書き込み・削除は、しない）。 */
export const S3_READ_ACTIONS = ['s3:ListBucket', 's3:GetObject'] as const;

/** 合成データを生成する Lambda が、ファイルサーバーのモックの S3 に使う操作（書き込みのみ。取り込み元の下だけ。読み取り・削除は、しない）。 */
export const S3_WRITE_ACTION = 's3:PutObject';

/**
 * 利用者の IP を入れるヘッダーの名前（小文字。API の Lambda の `CLIENT_IP_HEADER`）。関数の URL は、`X-Forwarded-For` を、
 * 最初の 1 つ（クライアントが付けられる値）に切り詰めるため、段数（`TRUSTED_PROXY_HOPS`）では、利用者の IP を識別できない
 * （Issue #100。ADR-0010）。
 */
export const CLIENT_IP_HEADER = 'x-sfm-viewer-ip';

/**
 * API への、CloudFront の viewer-request の Function。利用者の IP を、専用のヘッダーに、**上書き**で入れる
 * （利用者が同名のヘッダーを付けても、無効。CloudFront は、ヘッダー名を小文字にして渡す）。
 */
export const VIEWER_IP_CODE = `function handler(event) {
  var request = event.request;
  request.headers['${CLIENT_IP_HEADER}'] = { value: event.viewer.ip };
  return request;
}`;

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
  /**
   * 合成データを定期的に生成する Lambda（デモ。Issue #77）を作るか。既定は作る（開発サイト）。
   * 本番サイト（Issue #117）は、作らない（実データを扱う環境に、合成データを入れない。ADR-0013）。
   * ファイルサーバーのモックの S3 のバケットは、どちらも作る（Lambda には、ローカルのディレクトリがなく、
   * 未設定だと、取り込みが失敗し続けるため。本番サイトは、空のまま。実サーバーのアダプタは、Issue #119）
   */
  readonly includeDemoFeed?: boolean;
  /**
   * 接続元ごとのログインの失敗の制限（API の Lambda の環境変数 LOGIN_FAILURE_LIMIT・LOGIN_FAILURE_WINDOW_MINUTES）。
   * 既定は、失敗 5 回 / 15 分（Issue #244。D-44）。一部だけを指定すると、残りは、既定の値。
   */
  readonly loginFailurePolicy?: Partial<LoginFailurePolicy>;
  /**
   * Web Push の実配信（#241）。指定すると、API・ジョブの Lambda が、プッシュサービスへ実際に送る（WEB_PUSH_DELIVERY=vapid）。
   * 公開鍵は、VAPID の公開鍵（公開の値）。連絡先は、アプリの https の URL。秘密鍵は、パラメータストア（SecretPort）に置く。
   * 指定しなければ、ダミー（購読も受け付けない）。
   */
  readonly webPush?: { readonly publicKey: string; readonly subject: string };
  /**
   * サイトの環境（development・production。既定は development）。秘密情報の、パラメータストアのパスの接頭辞
   * （`/sfm/<環境>/`）になる。環境ごとにパスを分け、開発サイトが、本番サイトの秘密情報を読めないようにする（Issue #206）。
   */
  readonly siteEnvironment?: SiteEnvironment;
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

    // ファイルサーバーのモック（Issue #77。ADR-0012）のバケット。Lambda には、ローカルのディレクトリがないため、S3 に置く。
    // 構成は、ローカルのモックと同じ `<取り込み元の識別子>/<ファイル>`。置くのは、合成データだけ（実データ・個人情報は置かない）。
    // 評価環境と一緒に消す（状態を持たない）。ファイルは、一定の日数で自動で消す
    const fileServerBucket = new Bucket(this, 'FileServerBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(FILE_SERVER_RETENTION_DAYS) }],
    });

    // API（バックエンド本体。Issue #75）。ログの保持期間を絞る（費用。NFR-1.5・NFR-6.3）。
    // メモリ・タイムアウトは、初期値（Issue #79 の実測で調整する）: CPU はメモリに比例するため 1024 MB、
    // タイムアウトは、CloudFront のオリジンの応答の上限（30 秒）の内側
    const { data } = props;
    const credentialPathPrefix = `/sfm/${props.siteEnvironment ?? DEFAULT_SITE_ENVIRONMENT}/`;
    // API とジョブの Lambda が共有する、バックエンドの環境変数。秘密情報ではない（ID・テーブル名）。
    // 値は、データのスタックの出力から取る（リポジトリに ID を書かない）
    const backendEnvironment = {
      APP_MODE: 'production',
      PERSISTENCE: 'dynamodb',
      AUTH_PROVIDER: 'cognito',
      COGNITO_USER_POOL_ID: data.userPool.userPoolId,
      COGNITO_CLIENT_ID: data.userPoolClient.userPoolClientId,
      DYNAMODB_OBSERVATIONS_TABLE: data.observationsTable.tableName,
      DYNAMODB_MAIN_TABLE: data.mainTable.tableName,
      FILE_SERVER_S3_BUCKET: fileServerBucket.bucketName,
      // 秘密情報の保管先（パラメータストア）と、環境ごとのパスの接頭辞。値は、パスの名前で、秘密情報ではない（Issue #206）
      CREDENTIAL_STORE: 'ssm',
      CREDENTIAL_PATH_PREFIX: credentialPathPrefix,
      LOG_LEVEL: 'info',
      // Web Push の実配信（#241）。公開鍵と連絡先（公開の値）。秘密鍵は、環境変数に持たず、パラメータストアから読む
      ...(props.webPush === undefined
        ? {}
        : {
            WEB_PUSH_DELIVERY: 'vapid',
            WEB_PUSH_PUBLIC_KEY: props.webPush.publicKey,
            WEB_PUSH_SUBJECT: props.webPush.subject,
          }),
    };
    // 最小権限: 2 つのテーブル（インデックスを含む）への、必要な操作だけ
    const dataTablesPolicy = (): PolicyStatement =>
      new PolicyStatement({
        actions: [...DYNAMODB_ACTIONS],
        resources: [data.observationsTable, data.mainTable].flatMap((table) => [
          table.tableArn,
          `${table.tableArn}/index/*`,
        ]),
      });
    // ファイルサーバーのモックの読み取り（取り込み元の一覧・ファイルの内容）。最小権限: このバケットだけ・読み取りだけ
    const fileServerReadPolicies = (): PolicyStatement[] => [
      new PolicyStatement({
        actions: [S3_READ_ACTIONS[0]],
        resources: [fileServerBucket.bucketArn],
      }),
      new PolicyStatement({
        actions: [S3_READ_ACTIONS[1]],
        resources: [fileServerBucket.arnForObjects('*')],
      }),
    ];
    // 秘密情報（パラメータストア）: 環境のパスの下だけ。暗号化の鍵（AWS の管理の鍵）は、パラメータストア経由の利用に限る
    const credentialParametersArn = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: `${credentialPathPrefix.slice(1)}*`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const credentialPolicies = (
      ssmActions: readonly string[],
      kmsActions: readonly string[],
    ): PolicyStatement[] => [
      new PolicyStatement({ actions: [...ssmActions], resources: [credentialParametersArn] }),
      new PolicyStatement({
        actions: [...kmsActions],
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
    ];
    const apiFunction = new LambdaFunction(this, 'ApiFunction', {
      code: bundledLambdaCode(join(import.meta.dirname, '../../src/backend/runtime/lambda.ts')),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(29),
      // 手動入力の保存・削除の応答の前に、評価を再計算しない（定期の評価 JB-02 が更新する。Issue #123。ADR-0014）
      environment: {
        ...backendEnvironment,
        CLIENT_IP_HEADER,
        EVALUATION_ON_WRITE: 'deferred',
        // ログインを受けるのは、API だけ（ジョブの Lambda には、持たない）。値は、IaC のデプロイで決める（コードの変更は、要らない）
        LOGIN_FAILURE_LIMIT: String(props.loginFailurePolicy?.limit ?? LOGIN_FAILURE_LIMIT),
        LOGIN_FAILURE_WINDOW_MINUTES: String(
          props.loginFailurePolicy?.windowMinutes ?? LOGIN_FAILURE_WINDOW_MINUTES,
        ),
      },
      logGroup: new LogGroup(this, 'ApiLogGroup', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // Cognito は、ユーザープールに限る
    apiFunction.addToRolePolicy(dataTablesPolicy());
    for (const statement of fileServerReadPolicies()) {
      apiFunction.addToRolePolicy(statement);
    }
    for (const statement of credentialPolicies(SSM_API_ACTIONS, KMS_SSM_API_ACTIONS)) {
      apiFunction.addToRolePolicy(statement);
    }
    apiFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [...COGNITO_ACTIONS],
        resources: [data.userPool.userPoolArn],
      }),
    );
    const apiUrl = apiFunction.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // ジョブ（JB-01〜JB-04）の Lambda（Issue #76。ADR-0011）。EventBridge の 4 つのルールが、入力 { jobId } で起動する。
    // 認証は使わないため、Cognito の IAM は付けない。同じジョブの重複（前回の実行が終わる前の次の起動）は、
    // DynamoDB のリース式ロックで防ぐ。Lambda の自動の再試行は、しない（失敗は、次の周期で、再び実行される。二重の配信を避ける）
    const jobFunction = new LambdaFunction(this, 'JobFunction', {
      code: bundledLambdaCode(join(import.meta.dirname, '../../src/backend/runtime/job-lambda.ts')),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(JOB_LAMBDA_TIMEOUT_SECONDS),
      environment: backendEnvironment,
      logGroup: new LogGroup(this, 'JobLogGroup', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      retryAttempts: 0,
    });
    jobFunction.addToRolePolicy(dataTablesPolicy());
    for (const statement of fileServerReadPolicies()) {
      jobFunction.addToRolePolicy(statement);
    }
    for (const statement of credentialPolicies(SSM_JOB_ACTIONS, KMS_SSM_JOB_ACTIONS)) {
      jobFunction.addToRolePolicy(statement);
    }
    for (const plan of DEFAULT_SCHEDULE) {
      new Rule(this, `Schedule${plan.jobId.replace('-', '')}`, {
        description: `ジョブ ${plan.jobId} を ${String(plan.intervalMinutes)} 分ごとに起動する`,
        schedule: Schedule.rate(Duration.minutes(plan.intervalMinutes)),
        targets: [
          new LambdaFunctionTarget(jobFunction, {
            event: RuleTargetInput.fromObject({ jobId: plan.jobId }),
            // 配信の再試行もしない。起動の時刻から 1 分を過ぎたイベントは、捨てる（次の周期が、すぐ来る）
            retryAttempts: 0,
            maxEventAge: Duration.minutes(1),
          }),
        ],
      });
    }

    // 合成データの生成（デモ）の Lambda とルール。開発サイトだけ（includeDemoFeed）。本番サイトは、作らない（Issue #117）
    const demoFeedFunction =
      props.includeDemoFeed === false ? undefined : this.createDemoFeed(fileServerBucket);

    const spaRewrite = new CloudFrontFunction(this, 'SpaRewrite', {
      code: FunctionCode.fromInline(SPA_REWRITE_CODE),
      runtime: FunctionRuntime.JS_2_0,
    });
    const viewerIp = new CloudFrontFunction(this, 'ViewerIp', {
      code: FunctionCode.fromInline(VIEWER_IP_CODE),
      runtime: FunctionRuntime.JS_2_0,
    });
    const apiBehavior = {
      origin: new FunctionUrlOrigin(apiUrl),
      functionAssociations: [{ function: viewerIp, eventType: FunctionEventType.VIEWER_REQUEST }],
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      // Authorization ヘッダー・クエリを、オリジンへ渡す（Host は、関数の URL のものを使う）
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
    };
    // 画面（静的ファイル）の応答ヘッダー（Issue #127）。マネージドポリシー SECURITY_HEADERS と同じヘッダーに、CSP（frame-ancestors を含む）を加え、
    // X-Frame-Options を DENY にする（埋め込みを許さない）。API（/api/*・/health）は、これまでのマネージドポリシーのまま
    // （API の応答の CSP は、バックエンドが付ける）
    const staticHeadersPolicy = new ResponseHeadersPolicy(this, 'StaticHeadersPolicy', {
      comment:
        '画面の配信: SECURITY_HEADERS と同じヘッダー + CSP・X-Frame-Options DENY（Issue #127）',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: STATIC_CONTENT_SECURITY_POLICY,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: false,
          preload: false,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });
    const distribution = new Distribution(this, 'Distribution', {
      comment: 'smart-farm-monitoring evaluation environment',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: staticHeadersPolicy,
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

    // 画面のファイルを配置し、CloudFront のキャッシュを無効化する（デプロイのたびに、最新の画面になる）。
    // 配置の補助の Lambda のログも、保持期間を絞り、スタックを消すと一緒に消す（CDK の既定は 731 日・残る。Issue #80）。
    // ブラウザのキャッシュの指定（Cache-Control。Issue #323）のため、2 つに分けて配置する:
    // - assets/（ファイル名にハッシュがある。内容が変わればファイル名も変わる）: 長期のキャッシュ（immutable）
    // - それ以外（index.html・sw.js・manifest）: 毎回、更新を確認する（no-cache。ETag で、変わっていなければ 304）。
    //   古い index.html を使い続けて、デプロイで削除された古い部品を取得しにいく（画面が開かない）ことを防ぐ
    // どちらも、prune（配置元にないファイルの削除）を使う。include・exclude で、互いのファイルを、削除しない範囲にする
    const siteLogGroup = new LogGroup(this, 'SiteDeploymentLogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const assetsDeployment = new BucketDeployment(this, 'SiteAssetsDeployment', {
      sources: [Source.asset(props.frontendAssetPath)],
      destinationBucket: siteBucket,
      exclude: ['*'],
      include: ['assets/*'],
      cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: true,
      logGroup: siteLogGroup,
    });
    const siteDeployment = new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(props.frontendAssetPath)],
      destinationBucket: siteBucket,
      exclude: ['assets/*'],
      cacheControl: [CacheControl.noCache()],
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      logGroup: siteLogGroup,
    });
    // 新しい index.html は、新しい assets/ を配置したあとに、公開する（部品がない時間を作らない）
    siteDeployment.node.addDependency(assetsDeployment);

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
    new CfnOutput(this, 'JobFunctionName', { value: jobFunction.functionName });
    if (demoFeedFunction !== undefined) {
      new CfnOutput(this, 'DemoFeedFunctionName', { value: demoFeedFunction.functionName });
    }
    new CfnOutput(this, 'FileServerBucketName', {
      value: fileServerBucket.bucketName,
      description: 'ファイルサーバーのモック（合成データ）のバケット',
    });
  }

  /** 合成データを定期的に生成する Lambda と、EventBridge のルール（デモ。開発サイトだけ）。 */
  private createDemoFeed(fileServerBucket: Bucket): LambdaFunction {
    // 合成データを定期的に生成する Lambda（擬似のロボット・環境センサー。Issue #77。ADR-0012）。EventBridge が 15 分ごとに起動し、
    // ファイルサーバーのモックの S3 に、新しい合成データのファイルを置く。取り込み（JB-01）が、それを読む。
    // ジョブ（JB-01〜JB-04）とは別の関数・別の権限: **S3 への書き込みだけ**（取り込み元の下だけ）。DynamoDB・Cognito は使わない。
    // 失敗は、次の周期で、再び置く（再試行しない）
    const demoFeedFunction = new LambdaFunction(this, 'DemoFeedFunction', {
      code: bundledLambdaCode(
        join(import.meta.dirname, '../../src/backend/runtime/demo-feed-lambda.ts'),
      ),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(DEMO_FEED_TIMEOUT_SECONDS),
      environment: { FILE_SERVER_S3_BUCKET: fileServerBucket.bucketName },
      logGroup: new LogGroup(this, 'DemoFeedLogGroup', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      retryAttempts: 0,
    });
    demoFeedFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [S3_WRITE_ACTION],
        resources: DEMO_FEED_SOURCE_IDS.map((sourceId) =>
          fileServerBucket.arnForObjects(`${sourceId}/*`),
        ),
      }),
    );
    new Rule(this, 'ScheduleDemoFeed', {
      description: `合成データのファイルを ${String(DEMO_FEED_INTERVAL_MINUTES)} 分ごとに置く（デモ）`,
      schedule: Schedule.rate(Duration.minutes(DEMO_FEED_INTERVAL_MINUTES)),
      targets: [
        new LambdaFunctionTarget(demoFeedFunction, {
          retryAttempts: 0,
          maxEventAge: Duration.minutes(1),
        }),
      ],
    });
    return demoFeedFunction;
  }
}

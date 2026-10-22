/**
 * データ（DynamoDB のテーブルと、Cognito のユーザープール）のスタック。Issue #73・#74、ADR-0007・ADR-0008。
 *
 * 評価環境のスタック（EvaluationStack）とは別にして、評価環境を削除・再作成しても、データを失わないようにする。
 * - テーブルは 2 つ（観測値の `Observations`、そのほかの `Main`）。キー・インデックスは、
 *   アダプタ（src/backend/infrastructure/dynamodb/table-schema.ts）と同じ
 * - オンデマンド課金（固定費なし）。保存時の暗号化は、既定（AWS 所有のキー）
 * - 削除の保護: スタックの削除（terminationProtection）・テーブルの削除（deletionProtection）を有効にし、
 *   スタックを消しても、テーブルは残す（RemovalPolicy.RETAIN）。ポイントインタイムリカバリ（35 日）を有効にする（NFR-4.2）
 * - テーブル名は、CloudFormation に生成させる（作り直しのときの、名前の衝突を避ける）。名前は、出力（Output）で参照する
 * - Cognito のユーザープール: ユーザーID・パスワードを持つ（ユーザーも、状態のため、このスタック）。自己登録なし・
 *   メールアドレスなし・MFA なし（管理者が、ユーザーを作る）。ユーザーID は、大文字・小文字を区別する（ローカルの認証と同じ）。
 *   アプリクライアントは、API（サーバー側）が、IAM の権限で使う（AdminInitiateAuth）。シークレットなし。
 *   有効期限は、アプリの方針（アクセス 30 分・リフレッシュ 7 日。auth-policy.ts）と同じ。ユーザープールも、削除の保護・RETAIN
 * - TTL: Main テーブルの `ttl` の属性（エポック秒）。ログインの試行回数の記録（LOGINFAIL）が、期限で消える
 * - 完全に消すとき（データも失う）の手順は、docs/00_project/commands.md を参照
 */

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  FeaturePlan,
  Mfa,
  UserPool,
  type UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { type Construct } from 'constructs';
import {
  ACCESS_TOKEN_TTL_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
} from '../../src/backend/infrastructure/common/auth-policy.ts';
import {
  MAIN_INDEX_1,
  OBSERVATIONS_MANUAL_INDEX,
} from '../../src/backend/infrastructure/dynamodb/table-schema.ts';

const KEY = { name: 'pk', type: AttributeType.STRING } as const;
const SORT_KEY = { name: 'sk', type: AttributeType.STRING } as const;

export class DataStack extends Stack {
  readonly observationsTable: Table;
  readonly mainTable: Table;
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, { terminationProtection: true, ...props });
    const tableProps = {
      partitionKey: KEY,
      sortKey: SORT_KEY,
      billingMode: BillingMode.PAY_PER_REQUEST,
      // 期間は、AWS の既定（35 日）に任せず、明示する（backup-restore.md が、この値を前提にする）
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: 35,
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    } as const;

    this.observationsTable = new Table(this, 'Observations', tableProps);
    // 手動入力だけに付く、疎なインデックス（手動入力の一覧）
    this.observationsTable.addGlobalSecondaryIndex({
      indexName: OBSERVATIONS_MANUAL_INDEX,
      partitionKey: { name: 'g2', type: AttributeType.STRING },
      sortKey: { name: 'g2s', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.mainTable = new Table(this, 'Main', { ...tableProps, timeToLiveAttribute: 'ttl' });
    // 連携の未送信と、配信が未完了の通知（どちらも疎）
    this.mainTable.addGlobalSecondaryIndex({
      indexName: MAIN_INDEX_1,
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.userPool = new UserPool(this, 'UserPool', {
      // 管理者（ユーザー管理の画面・最初のユーザーを作るコマンド）が作る。自己登録・メール・SMS・MFA・パスワードの回復はなし
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      signInCaseSensitive: true,
      accountRecovery: AccountRecovery.NONE,
      mfa: Mfa.OFF,
      passwordPolicy: {
        // アプリの条件（shared の findPasswordPolicyViolation）と同じ: 8 文字以上、英大文字・英小文字・数字
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      featurePlan: FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.userPoolClient = this.userPool.addClient('Api', {
      generateSecret: false,
      // サーバー側（API）が、IAM の権限で、パスワードによる認証（AdminInitiateAuth）をする。ブラウザからは、使わない
      authFlows: { adminUserPassword: true },
      accessTokenValidity: Duration.minutes(ACCESS_TOKEN_TTL_MINUTES),
      idTokenValidity: Duration.minutes(ACCESS_TOKEN_TTL_MINUTES),
      refreshTokenValidity: Duration.days(REFRESH_TOKEN_TTL_DAYS),
      // ユーザーの存在を、エラーの違いで、推測させない
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'COGNITO_USER_POOL_ID に設定する、ユーザープールの ID',
    });
    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'COGNITO_CLIENT_ID に設定する、アプリクライアントの ID',
    });
    new CfnOutput(this, 'ObservationsTableName', {
      value: this.observationsTable.tableName,
      description: 'DYNAMODB_OBSERVATIONS_TABLE に設定する、観測値のテーブルの名前',
    });
    new CfnOutput(this, 'MainTableName', {
      value: this.mainTable.tableName,
      description: 'DYNAMODB_MAIN_TABLE に設定する、そのほかのテーブルの名前',
    });
  }
}

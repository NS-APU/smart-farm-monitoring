/**
 * データ（DynamoDB のテーブル）のスタック。Issue #73、ADR-0007。
 *
 * 評価環境のスタック（EvaluationStack）とは別にして、評価環境を削除・再作成しても、データを失わないようにする。
 * - テーブルは 2 つ（観測値の `Observations`、そのほかの `Main`）。キー・インデックスは、
 *   アダプタ（src/backend/infrastructure/dynamodb/table-schema.ts）と同じ
 * - オンデマンド課金（固定費なし）。保存時の暗号化は、既定（AWS 所有のキー）
 * - 削除の保護: スタックの削除（terminationProtection）・テーブルの削除（deletionProtection）を有効にし、
 *   スタックを消しても、テーブルは残す（RemovalPolicy.RETAIN）。ポイントインタイムリカバリ（35 日）を有効にする（NFR-4.2）
 * - テーブル名は、CloudFormation に生成させる（作り直しのときの、名前の衝突を避ける）。名前は、出力（Output）で参照する
 * - 完全に消すとき（データも失う）の手順は、docs/00_project/commands.md を参照
 */

import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { type Construct } from 'constructs';
import {
  MAIN_INDEX_1,
  OBSERVATIONS_MANUAL_INDEX,
} from '../../src/backend/infrastructure/dynamodb/table-schema.ts';

const KEY = { name: 'pk', type: AttributeType.STRING } as const;
const SORT_KEY = { name: 'sk', type: AttributeType.STRING } as const;

export class DataStack extends Stack {
  readonly observationsTable: Table;
  readonly mainTable: Table;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, { terminationProtection: true, ...props });
    const tableProps = {
      partitionKey: KEY,
      sortKey: SORT_KEY,
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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

    this.mainTable = new Table(this, 'Main', tableProps);
    // 連携の未送信と、配信が未完了の通知（どちらも疎）
    this.mainTable.addGlobalSecondaryIndex({
      indexName: MAIN_INDEX_1,
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
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

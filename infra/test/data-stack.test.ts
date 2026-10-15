import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  mainTableDefinition,
  observationsTableDefinition,
} from '../../src/backend/infrastructure/dynamodb/table-schema.ts';
import { DataStack } from '../lib/data-stack.ts';

interface TableResource {
  readonly Type: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly Properties: {
    readonly TableName?: unknown;
    readonly BillingMode?: string;
    readonly DeletionProtectionEnabled?: boolean;
    readonly PointInTimeRecoverySpecification?: { PointInTimeRecoveryEnabled?: boolean };
    readonly KeySchema: { AttributeName: string; KeyType: string }[];
    readonly AttributeDefinitions: { AttributeName: string; AttributeType: string }[];
    readonly GlobalSecondaryIndexes?: {
      IndexName: string;
      KeySchema: { AttributeName: string; KeyType: string }[];
      Projection: { ProjectionType: string };
    }[];
  };
}

function build(): { template: Template; tables: TableResource[]; stack: DataStack } {
  const stack = new DataStack(new App(), 'Data');
  const template = Template.fromStack(stack);
  const resources = template.toJSON().Resources as Record<string, TableResource>;
  return {
    template,
    stack,
    tables: Object.values(resources).filter((resource) => resource.Type === 'AWS::DynamoDB::Table'),
  };
}

/** テーブルの定義を、比較できる形（順序に依存しない）にする。 */
function shapeOf(properties: {
  KeySchema?: { AttributeName?: string; KeyType?: string }[] | undefined;
  AttributeDefinitions?: { AttributeName?: string; AttributeType?: string }[] | undefined;
  GlobalSecondaryIndexes?:
    | {
        IndexName?: string;
        KeySchema?: { AttributeName?: string; KeyType?: string }[] | undefined;
        Projection?: { ProjectionType?: string } | undefined;
      }[]
    | undefined;
}): unknown {
  const byName = <Item extends { AttributeName?: string }>(items: Item[] | undefined): Item[] =>
    [...(items ?? [])].sort((left, right) =>
      (left.AttributeName ?? '').localeCompare(right.AttributeName ?? ''),
    );
  return {
    keys: byName(properties.KeySchema),
    attributes: byName(properties.AttributeDefinitions),
    indexes: [...(properties.GlobalSecondaryIndexes ?? [])]
      .map((index) => ({
        name: index.IndexName,
        keys: byName(index.KeySchema),
        projection: index.Projection?.ProjectionType,
      }))
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? '')),
  };
}

describe('データ（DynamoDB）のスタック', () => {
  it('テーブルは 2 つ（観測値・そのほか）で、オンデマンド課金', () => {
    const { template, tables } = build();

    template.resourceCountIs('AWS::DynamoDB::Table', 2);
    expect(tables.map((table) => table.Properties.BillingMode)).toEqual([
      'PAY_PER_REQUEST',
      'PAY_PER_REQUEST',
    ]);
  });

  it('キー・インデックスは、アダプタのテスト用の定義（table-schema.ts）と同じ', () => {
    const { tables } = build();
    const observations = tables.find((table) =>
      table.Properties.GlobalSecondaryIndexes?.some((index) => index.IndexName === 'manual'),
    );
    const main = tables.find((table) =>
      table.Properties.GlobalSecondaryIndexes?.some((index) => index.IndexName === 'gsi1'),
    );

    expect(shapeOf(observations?.Properties ?? { KeySchema: [] })).toEqual(
      shapeOf(observationsTableDefinition('x')),
    );
    expect(shapeOf(main?.Properties ?? { KeySchema: [] })).toEqual(
      shapeOf(mainTableDefinition('x')),
    );
  });

  it('データを守る: スタックの削除・テーブルの削除の保護、スタックを消しても残す、35 日のポイントインタイムリカバリ', () => {
    const { tables, stack } = build();

    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.Properties.DeletionProtectionEnabled).toBe(true);
      expect(table.DeletionPolicy).toBe('Retain');
      expect(table.UpdateReplacePolicy).toBe('Retain');
      expect(table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled).toBe(
        true,
      );
    }
    expect(stack.terminationProtection).toBe(true);
  });

  it('テーブル名は、CloudFormation に生成させる（名前の衝突を避ける）。名前は、出力で参照できる', () => {
    const { template, tables } = build();

    for (const table of tables) {
      expect(table.Properties.TableName).toBeUndefined();
    }
    template.hasOutput('ObservationsTableName', {
      Value: Match.objectLike({ Ref: Match.anyValue() }),
    });
    template.hasOutput('MainTableName', { Value: Match.objectLike({ Ref: Match.anyValue() }) });
  });
});

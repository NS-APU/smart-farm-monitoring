/**
 * 農業情報基盤への連携の変換（NGSI-LD のエンティティ。ADR-0024。Issue #177 の PR 1）の単体テスト。
 * 観測値 → エンティティ（環境は IndoorEnvironmentObserved、ほかは EquipmentObserved）、評価 → ViewpointEvaluation、
 * 要求の分け方（同じエンティティの複数の時刻は、古い順の別の要求）。
 */

import { describe, expect, it } from 'vitest';
import { toUserId } from '../../../../src/shared/schemas/common.ts';
import type { EquipmentType } from '../../../../src/shared/constants/status.ts';
import type { FederationItem } from '../../../../src/shared/schemas/ingestion.ts';
import type { Observation } from '../../../../src/shared/schemas/observation.ts';
import {
  attributeNameOf,
  entityIdOf,
  fragmentsOfItem,
  requestsOf,
  unitCodeOf,
  type NgsiLdFragment,
} from '../../../../src/backend/domain/ngsi-ld-mapping.ts';
import { FACILITY_ID, ROBOT_ID, SENSOR_ID, observation } from '../../../support/builders.ts';

const TYPES: Readonly<Record<string, EquipmentType>> = {
  [FACILITY_ID]: 'FACILITY',
  [ROBOT_ID]: 'ROBOT',
  [SENSOR_ID]: 'SENSOR',
};
const typeOf = (equipmentId: string): EquipmentType | undefined => TYPES[equipmentId];

function observationItem(observations: readonly Observation[]): FederationItem {
  return {
    federationItemId: 'item-1',
    targetType: 'OBSERVATION',
    targetRef: 'environment-sensor#file-1',
    payload: { sourceId: 'environment-sensor', fileId: 'file-1', observations },
    status: 'PENDING',
    attempts: 0,
    enqueuedAt: '2026-10-09T02:00:00.000Z',
    updatedAt: '2026-10-09T02:00:00.000Z',
    nextAttemptAt: '2026-10-09T02:00:00.000Z',
  };
}

function evaluationItem(payload: Record<string, unknown>): FederationItem {
  return {
    ...observationItem([]),
    targetType: 'EVALUATION',
    targetRef: `${ROBOT_ID}#harvestAccuracy`,
    payload,
  };
}

const AT = '2026-10-09T02:00:00.000Z';

describe('名前・識別子・単位', () => {
  it('エンティティの識別子は、urn:ngsi-ld:{型}:{設備の ID} で、URN で使えない文字は、パーセントエンコードする', () => {
    expect(entityIdOf('IndoorEnvironmentObserved', 'SENSOR-T1')).toBe(
      'urn:ngsi-ld:IndoorEnvironmentObserved:SENSOR-T1',
    );
    expect(entityIdOf('ViewpointEvaluation', 'ROBOT 1', 'harvestAccuracy')).toBe(
      'urn:ngsi-ld:ViewpointEvaluation:ROBOT%201:harvestAccuracy',
    );
  });

  it('環境の 4 項目は標準の属性名、満足度の識別子の「.」は、ローワーキャメルにする。そのほかは、項目の識別子のまま', () => {
    expect(attributeNameOf('temperatureCelsius')).toBe('temperature');
    expect(attributeNameOf('humidityPercent')).toBe('relativeHumidity');
    expect(attributeNameOf('illuminanceLux')).toBe('illuminance');
    expect(attributeNameOf('co2Ppm')).toBe('co2');
    expect(attributeNameOf('satisfaction.harvestAccuracy')).toBe('satisfactionHarvestAccuracy');
    expect(attributeNameOf('harvestCount')).toBe('harvestCount');
    expect(attributeNameOf('statusCode')).toBe('statusCode');
  });

  it.each([
    ['℃', 'CEL'],
    ['%', 'P1'],
    ['lx', 'LUX'],
    ['ppm', '59'],
    ['時間', 'HUR'],
    ['分', 'MIN'],
    ['秒/果実', 'SEC'],
    ['個', 'C62'],
    ['回', 'C62'],
    ['件', 'C62'],
  ])('単位 %s の unitCode は %s', (unit, code) => {
    expect(unitCodeOf(unit)).toBe(code);
  });

  it.each(['円', '円/時間', 'スター', ''])('単位 "%s" には、unitCode を付けない', (unit) => {
    expect(unitCodeOf(unit)).toBeUndefined();
  });
});

describe('観測値 → エンティティ', () => {
  it('センサーの環境の 4 項目は、同じ時刻なら、1 つの IndoorEnvironmentObserved にまとめる（標準の属性名・unitCode・計測日時・取得元・refDevice）', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({ equipmentId: SENSOR_ID, itemKey: 'temperatureCelsius', value: 27.5 }),
        observation({ equipmentId: SENSOR_ID, itemKey: 'humidityPercent', value: 60 }),
        observation({ equipmentId: SENSOR_ID, itemKey: 'illuminanceLux', value: 30000 }),
        observation({ equipmentId: SENSOR_ID, itemKey: 'co2Ppm', value: 900 }),
      ]),
      typeOf,
    );

    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.at).toBe(AT);
    expect(fragments[0]?.entity).toEqual({
      id: `urn:ngsi-ld:IndoorEnvironmentObserved:${SENSOR_ID}`,
      type: 'IndoorEnvironmentObserved',
      dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': AT } },
      refDevice: { type: 'Relationship', object: `urn:ngsi-ld:EnvironmentSensor:${SENSOR_ID}` },
      temperature: property(27.5, 'CEL'),
      relativeHumidity: property(60, 'P1'),
      illuminance: property(30000, 'LUX'),
      co2: property(900, '59'),
    });
  });

  it('センサー以外の設備の環境の項目（手動入力）も、IndoorEnvironmentObserved にする（refDevice は付けない。取得元は MANUAL）', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({
          equipmentId: FACILITY_ID,
          itemKey: 'temperatureCelsius',
          value: 24,
          source: 'MANUAL',
        }),
      ]),
      typeOf,
    );

    expect(fragments[0]?.entity).toEqual({
      id: `urn:ngsi-ld:IndoorEnvironmentObserved:${FACILITY_ID}`,
      type: 'IndoorEnvironmentObserved',
      dateObserved: { type: 'Property', value: { '@type': 'DateTime', '@value': AT } },
      temperature: property(24, 'CEL', 'MANUAL'),
    });
  });

  it('環境以外の項目は、設備ごとの EquipmentObserved にまとめる（項目の識別子の属性名・unitCode・refEquipment。ステータスコードは、文字列）', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 120 }),
        observation({ equipmentId: ROBOT_ID, itemKey: 'operatingHours', value: 5.5 }),
        observation({ equipmentId: ROBOT_ID, itemKey: 'statusCode', value: 'RUNNING' }),
        observation({
          equipmentId: ROBOT_ID,
          itemKey: 'robotCostYenPerHour',
          value: 1200,
          source: 'MANUAL',
        }),
      ]),
      typeOf,
    );

    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.entity).toEqual({
      id: `urn:ngsi-ld:EquipmentObserved:${ROBOT_ID}`,
      type: 'EquipmentObserved',
      refEquipment: { type: 'Relationship', object: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}` },
      harvestCount: property(120, 'C62'),
      operatingHours: property(5.5, 'HUR'),
      statusCode: property('RUNNING'),
      robotCostYenPerHour: property(1200, undefined, 'MANUAL'),
    });
  });

  it('満足度の項目は、属性名の「.」を取り除いて送る（unitCode なし）', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({
          equipmentId: FACILITY_ID,
          itemKey: 'satisfaction.harvestAccuracy',
          value: 4,
          source: 'MANUAL',
        }),
      ]),
      typeOf,
    );

    expect(fragments[0]?.entity).toMatchObject({
      id: `urn:ngsi-ld:EquipmentObserved:${FACILITY_ID}`,
      refEquipment: { object: `urn:ngsi-ld:Greenhouse:${FACILITY_ID}` },
      satisfactionHarvestAccuracy: property(4, undefined, 'MANUAL'),
    });
  });

  it('計測日時が違えば、別の断片にし、古い順に並べる', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({
          equipmentId: ROBOT_ID,
          itemKey: 'harvestCount',
          value: 2,
          observedAt: '2026-10-09T02:02:00.000Z',
        }),
        observation({
          equipmentId: ROBOT_ID,
          itemKey: 'harvestCount',
          value: 1,
          observedAt: '2026-10-09T02:01:00.000Z',
        }),
      ]),
      typeOf,
    );

    expect(fragments.map((fragment) => fragment.at)).toEqual([
      '2026-10-09T02:01:00.000Z',
      '2026-10-09T02:02:00.000Z',
    ]);
  });

  it('送らないもの: 削除済み・値のない（欠損）・不正・カタログにない項目の観測値、手動入力の備考・入力者', () => {
    const manual: Observation = {
      ...observation({
        equipmentId: ROBOT_ID,
        itemKey: 'failureCount',
        value: 2,
        source: 'MANUAL',
        enteredBy: toUserId('user-secret-name'),
      }),
      note: '備考の内容（個人の所感）',
    };
    const fragments = fragmentsOfItem(
      observationItem([
        manual,
        observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1, isDeleted: true }),
        observation({ equipmentId: ROBOT_ID, itemKey: 'operatingHours', value: null }),
        observation({
          equipmentId: ROBOT_ID,
          itemKey: 'standbyHours',
          value: -1,
          quality: 'INVALID',
        }),
        observation({
          equipmentId: ROBOT_ID,
          itemKey: 'travelStoppedHours',
          value: null,
          quality: 'MISSING',
        }),
        {
          ...observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 3 }),
          itemKey: 'unknownItem',
        },
      ]),
      typeOf,
    );

    expect(fragments).toHaveLength(1);
    const json = JSON.stringify(fragments);
    expect(json).toContain('failureCount');
    expect(json).not.toContain('harvestCount');
    expect(json).not.toContain('operatingHours');
    expect(json).not.toContain('standbyHours');
    expect(json).not.toContain('unknownItem');
    expect(json).not.toContain('備考の内容');
    expect(json).not.toContain('user-secret-name');
  });

  it('遅延（LATE）の観測値は、送る', () => {
    const fragments = fragmentsOfItem(
      observationItem([
        observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1, quality: 'LATE' }),
      ]),
      typeOf,
    );

    expect(fragments).toHaveLength(1);
  });

  it('設備の種別が分からないときは、refEquipment・refDevice を付けない', () => {
    const fragments = fragmentsOfItem(
      observationItem([observation({ equipmentId: ROBOT_ID, itemKey: 'harvestCount', value: 1 })]),
      () => undefined,
    );

    expect(fragments[0]?.entity).not.toHaveProperty('refEquipment');
  });
});

describe('評価 → ViewpointEvaluation', () => {
  const payload = {
    equipmentId: ROBOT_ID,
    viewpointId: 'harvestAccuracy',
    status: 'CAUTION',
    metrics: { marketableFruitRatePercent: 91.5, missedFruitRatePercent: null },
    diagnosticMessage: '可販果率が基準を下回っています',
    recommendedAction: 'カメラの清掃を確認してください',
    evaluatedAt: AT,
  };

  it('設備×観点のエンティティにし、ステータス・診断・推奨アクション・指標（数値の属性。欠損の指標は送らない）・refEquipment を持たせる', () => {
    const fragments = fragmentsOfItem(evaluationItem(payload), typeOf);

    expect(fragments).toEqual([
      {
        at: AT,
        entity: {
          id: `urn:ngsi-ld:ViewpointEvaluation:${ROBOT_ID}:harvestAccuracy`,
          type: 'ViewpointEvaluation',
          refEquipment: { type: 'Relationship', object: `urn:ngsi-ld:HarvestRobot:${ROBOT_ID}` },
          status: evaluationProperty('CAUTION'),
          diagnosticMessage: evaluationProperty('可販果率が基準を下回っています'),
          recommendedAction: evaluationProperty('カメラの清掃を確認してください'),
          metricMarketableFruitRatePercent: evaluationProperty(91.5, 'P1'),
        },
      },
    ]);
  });

  it('内容が正しくない評価は、送らない（空の配列）', () => {
    expect(fragmentsOfItem(evaluationItem({ equipmentId: ROBOT_ID }), typeOf)).toEqual([]);
  });
});

describe('要求の分け方（requestsOf）', () => {
  const fragment = (id: string, at: string): NgsiLdFragment => ({
    at,
    entity: { id, type: 'EquipmentObserved' },
  });

  it('同じエンティティの複数の時刻は、古い順に、別の要求にする（同じ要求に、同じエンティティは 1 つだけ）', () => {
    const requests = requestsOf(
      [
        fragment('urn:ngsi-ld:EquipmentObserved:A', '2026-10-09T02:02:00.000Z'),
        fragment('urn:ngsi-ld:EquipmentObserved:A', '2026-10-09T02:01:00.000Z'),
        fragment('urn:ngsi-ld:EquipmentObserved:B', '2026-10-09T02:01:00.000Z'),
      ],
      100,
    );

    expect(requests.map((entities) => entities.map((entity) => entity.id))).toEqual([
      ['urn:ngsi-ld:EquipmentObserved:A', 'urn:ngsi-ld:EquipmentObserved:B'],
      ['urn:ngsi-ld:EquipmentObserved:A'],
    ]);
  });

  it('1 回の要求のエンティティは、上限（100）まで。超えたら、複数の要求に分ける', () => {
    const fragments = Array.from({ length: 250 }, (_, index) =>
      fragment(`urn:ngsi-ld:EquipmentObserved:E${String(index)}`, AT),
    );

    const requests = requestsOf(fragments, 100);

    expect(requests.map((entities) => entities.length)).toEqual([100, 100, 50]);
  });

  it('断片がなければ、要求もない', () => {
    expect(requestsOf([], 100)).toEqual([]);
  });
});

function evaluationProperty(value: number | string, unitCode?: string): Record<string, unknown> {
  return {
    type: 'Property',
    value,
    ...(unitCode === undefined ? {} : { unitCode }),
    observedAt: AT,
  };
}

function property(
  value: number | string,
  unitCode?: string,
  source: 'AUTO_IMPORT' | 'MANUAL' = 'AUTO_IMPORT',
): Record<string, unknown> {
  return {
    type: 'Property',
    value,
    ...(unitCode === undefined ? {} : { unitCode }),
    observedAt: AT,
    source: { type: 'Property', value: source },
  };
}

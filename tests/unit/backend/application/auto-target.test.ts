/**
 * 自動取り込みの対象の判定（Issue #202。ADR-0016 の D-12）の単体テスト。
 * 設備は、取り込み元が有効で、種別が同じで、取得先がある（設備ごとのファイルパスを持つ。ファイルサーバーは HTTP。ADR-0023）とき、
 * 自動取り込みの対象。対象でない設備（手動のみの運用）は、「古い」「未取得」の警告を出さない。
 */

import { describe, expect, it } from 'vitest';
import type { IngestionSource } from '../../../../src/shared/schemas/ingestion.ts';
import { isAutoIngestionTarget } from '../../../../src/backend/application/ingestion/auto-target.ts';

const ROBOT_WITH_PATH = { equipmentType: 'ROBOT', sourceFilePath: '/robots/1.json' } as const;

function source(overrides: Partial<IngestionSource> = {}): IngestionSource {
  return {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-json',
    isEnabled: true,
    ...overrides,
  };
}

describe('自動取り込みの対象', () => {
  it('取り込み元が有効で、種別が同じで、設備にファイルパスがあれば、対象', () => {
    expect(isAutoIngestionTarget(ROBOT_WITH_PATH, [source()])).toBe(true);
  });

  it('取り込み元が無効なら、ファイルパスがあっても、対象でない', () => {
    expect(isAutoIngestionTarget(ROBOT_WITH_PATH, [source({ isEnabled: false })])).toBe(false);
  });

  it('種別が違う取り込み元だけなら、対象でない', () => {
    expect(
      isAutoIngestionTarget({ equipmentType: 'SENSOR', sourceFilePath: '/sensors/1.json' }, [
        source(),
        source({ isEnabled: false, sourceId: 'environment-sensor', kind: 'SENSOR' }),
      ]),
    ).toBe(false);
  });

  it('設備にファイルパスがなければ、取り込み元が有効で、種別が同じでも、対象でない（取得されない）', () => {
    expect(isAutoIngestionTarget({ equipmentType: 'ROBOT' }, [source()])).toBe(false);
  });

  it('ハウスは、対象でない（取り込み元の種別に、ハウスはない）。取り込み元がなければ、対象でない', () => {
    expect(
      isAutoIngestionTarget({ equipmentType: 'FACILITY', sourceFilePath: '/houses/1.json' }, [
        source(),
      ]),
    ).toBe(false);
    expect(isAutoIngestionTarget(ROBOT_WITH_PATH, [])).toBe(false);
  });
});

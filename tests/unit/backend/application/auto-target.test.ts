/**
 * 自動取り込みの対象の判定（Issue #202。ADR-0016 の D-12）の単体テスト。
 * 設備は、取り込み元が有効で、種別が同じで、取得先がある（HTTP は、設備ごとのファイルパス。モック・S3 は、種別が合えば対象）とき、
 * 自動取り込みの対象。対象でない設備（手動のみの運用）は、「古い」「未取得」の警告を出さない。
 */

import { describe, expect, it } from 'vitest';
import type { IngestionSource } from '../../../../src/shared/schemas/ingestion.ts';
import { isAutoIngestionTarget } from '../../../../src/backend/application/ingestion/auto-target.ts';

const HTTP: IngestionSource['connection'] = {
  type: 'HTTP',
  protocol: 'HTTPS',
  host: 'files.example.invalid',
  authMethod: 'NONE',
  apiKeyHeaderName: 'X-API-Key',
};

function source(overrides: Partial<IngestionSource> = {}): IngestionSource {
  return {
    sourceId: 'robot',
    kind: 'ROBOT',
    profileId: 'robot-json',
    connectionRef: 'FILE_SERVER_MOCK',
    connection: { type: 'MOCK' },
    isEnabled: true,
    ...overrides,
  };
}

describe('自動取り込みの対象', () => {
  it('取り込み元が有効で、種別が同じなら、対象（モック・S3 は、ファイルパスがなくても対象）', () => {
    expect(isAutoIngestionTarget({ equipmentType: 'ROBOT' }, [source()])).toBe(true);
  });

  it('取り込み元が無効なら、対象でない', () => {
    expect(isAutoIngestionTarget({ equipmentType: 'ROBOT' }, [source({ isEnabled: false })])).toBe(
      false,
    );
  });

  it('種別が違う取り込み元だけなら、対象でない', () => {
    expect(
      isAutoIngestionTarget({ equipmentType: 'SENSOR' }, [
        source(),
        source({ isEnabled: false, sourceId: 'environment-sensor', kind: 'SENSOR' }),
      ]),
    ).toBe(false);
  });

  it('HTTP は、設備ごとのファイルパスがあれば対象。なければ、取り込み元が有効でも、対象でない（取得されない）', () => {
    const http = source({ connection: HTTP });

    expect(
      isAutoIngestionTarget({ equipmentType: 'ROBOT', sourceFilePath: '/robots/1.json' }, [http]),
    ).toBe(true);
    expect(isAutoIngestionTarget({ equipmentType: 'ROBOT' }, [http])).toBe(false);
  });

  it('ハウスは、対象でない（取り込み元の種別に、ハウスはない）。取り込み元がなければ、対象でない', () => {
    expect(isAutoIngestionTarget({ equipmentType: 'FACILITY' }, [source()])).toBe(false);
    expect(isAutoIngestionTarget({ equipmentType: 'ROBOT' }, [])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createDefaultFormatProfileRegistry,
  splitCsvLine,
} from '../../../../src/backend/infrastructure/format-profiles/declarative-profile.ts';

const sensor = createDefaultFormatProfileRegistry().get('environment-sensor-csv');
if (sensor === undefined) {
  throw new Error('テストの前提: 環境センサーの FormatProfile がある');
}

describe('splitCsvLine（引用符つきの値。V-196）', () => {
  it.each([
    ['a,b,c', ['a', 'b', 'c']],
    ['"a,b",c', ['a,b', 'c']],
    ['"He said ""hi""",x', ['He said "hi"', 'x']],
    ['a,"",c', ['a', '', 'c']],
    ['a,"b', ['a', '"b']],
    ['a,b"c,d', ['a', 'b"c', 'd']],
  ])('%s', (line, expected) => {
    expect(splitCsvLine(line, ',')).toEqual(expected);
  });
});

describe('CSV: BOM・引用符（V-196）', () => {
  it('UTF-8 の BOM つきのファイルも、先頭の見出し（sensor_id）を、正しく読む', () => {
    const bom = String.fromCodePoint(0xfeff);

    const parsed = sensor.parse(
      `${bom}sensor_id,timestamp,temperature_c\nS,2026-10-09T01:00:00Z,20\n`,
    );

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      externalId: 'S',
      fields: { temperatureCelsius: 20 },
    });
  });

  it('引用符で囲んだ値（区切り文字を含む）の行も、列の数がずれず、読める', () => {
    const parsed = sensor.parse(
      'sensor_id,timestamp,temperature_c\n"S,1","2026-10-09T01:00:00Z","21.5"\n',
    );

    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.records[0]).toMatchObject({
      externalId: 'S,1',
      fields: { temperatureCelsius: 21.5 },
    });
  });
});

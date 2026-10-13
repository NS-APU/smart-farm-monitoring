/**
 * 負荷テストの許容時間の係数（tests/stress/support/limits.ts）の単体テスト。
 * 背景: GitHub のランナーは、CPU の速さが実行のたびに違い、同時 10 人の保存（UC-06）が、許容 3 秒を超えたり超えなかったりした。
 * NFR の値（3 秒など）は変えず、実行環境（CI）だけ、環境変数 STRESS_LIMIT_FACTOR で、倍率をかけられるようにする。
 */

import { describe, expect, it } from 'vitest';
import { LIMITS, effectiveLimit, parseLimitFactor } from '../../stress/support/limits.ts';

describe('parseLimitFactor', () => {
  it('指定がない・空のときは、1（NFR の値のまま）にする', () => {
    expect(parseLimitFactor(undefined)).toBe(1);
    expect(parseLimitFactor('')).toBe(1);
    expect(parseLimitFactor('  ')).toBe(1);
  });

  it('1 以上 3 以下の数値は、そのまま使う（境界を含む）', () => {
    expect(parseLimitFactor('1')).toBe(1);
    expect(parseLimitFactor('1.5')).toBe(1.5);
    expect(parseLimitFactor('3')).toBe(3);
  });

  it.each(['0.9', '0', '-1', '3.01', '10', 'abc', 'NaN', 'Infinity', '1,5'])(
    '範囲外・数値でない値（%s）は、黙って無視せず、エラーにする（許容時間が、意図せず、厳しくなったり、実質なくなったりしない）',
    (raw) => {
      expect(() => parseLimitFactor(raw)).toThrow('STRESS_LIMIT_FACTOR');
    },
  );
});

describe('effectiveLimit', () => {
  it('係数 1 のときは、NFR の値（LIMITS）のままである', () => {
    for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      expect(effectiveLimit(key, 1).seconds).toBe(LIMITS[key].seconds);
    }
  });

  it('係数をかけた許容時間を返す（操作は 3 秒 → 4.5 秒、ジョブは 10 秒 → 15 秒）。根拠の文言は変えない', () => {
    expect(effectiveLimit('operation', 1.5).seconds).toBe(4.5);
    expect(effectiveLimit('job', 1.5).seconds).toBe(15);
    expect(effectiveLimit('operation', 1.5).basis).toBe(LIMITS.operation.basis);
  });

  it('小数の係数でも、浮動小数点の誤差が出ない（小数第 3 位に丸める）', () => {
    expect(effectiveLimit('operation', 1.1).seconds).toBe(3.3);
    expect(effectiveLimit('screen', 1.7).seconds).toBe(5.1);
  });
});

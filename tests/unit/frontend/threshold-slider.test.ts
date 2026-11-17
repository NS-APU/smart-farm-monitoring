import { describe, expect, it } from 'vitest';
import {
  roundToStep,
  sliderValueText,
  thresholdSliderRange,
} from '../../../src/frontend/components/threshold-slider.ts';

describe('スライダーの値の丸め', () => {
  it('目盛りの桁数に丸める（浮動小数点の誤差を出さない）', () => {
    expect(roundToStep(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundToStep(0.30000000000000004, 0.001)).toBe(0.3);
    expect(roundToStep(30.5, 0.5)).toBe(30.5);
    expect(roundToStep(12, 1)).toBe(12);
    expect(sliderValueText(0.7000000000000001, 0.01)).toBe('0.7');
    expect(sliderValueText(1000, 1000)).toBe('1000');
  });
});

describe('スライダーの範囲', () => {
  it('指標の目安の範囲を、そのまま使う（現在の閾値が、範囲の中なら）', () => {
    expect(thresholdSliderRange('temperatureCelsius', [0, 10, 25, 35])).toEqual({
      min: -10,
      max: 50,
      step: 0.5,
    });
    expect(thresholdSliderRange('overallSatisfaction', [4, 3])).toEqual({
      min: 1,
      max: 5,
      step: 0.1,
    });
  });

  it('入力の値が範囲の外にあるときは、その値を含むように、目盛りの単位で広げる（上にも下にも）', () => {
    expect(thresholdSliderRange('temperatureCelsius', [0, 10, 25, 62.2])).toMatchObject({
      min: -10,
      max: 62.5,
    });
    expect(thresholdSliderRange('temperatureCelsius', [-23, 10])).toMatchObject({
      min: -23,
      max: 50,
    });
    expect(thresholdSliderRange('co2Ppm', [200, 800, 1000, 5001])).toMatchObject({
      max: 5050,
    });
  });

  it('数値として読めない値（NaN・無限大）は、範囲の決定に使わない。値がなければ、目安のまま', () => {
    expect(thresholdSliderRange('humidityPercent', [Number.NaN, 40])).toEqual({
      min: 0,
      max: 100,
      step: 1,
    });
    expect(thresholdSliderRange('humidityPercent', [Number.NaN])).toEqual({
      min: 0,
      max: 100,
      step: 1,
    });
    expect(thresholdSliderRange('humidityPercent', [Number.POSITIVE_INFINITY, 40]).max).toBe(100);
  });

  it('目安のない指標は、入力の値から決める（0 以上なら 0 から、最大値の 2 倍まで。目盛りは 10 の冪）', () => {
    expect(thresholdSliderRange('unknownMetric', [3, 8])).toEqual({ min: 0, max: 16, step: 0.1 });
    expect(thresholdSliderRange('unknownMetric', [300, 900])).toEqual({
      min: 0,
      max: 1800,
      step: 10,
    });
    expect(thresholdSliderRange('unknownMetric', [-5, 5])).toMatchObject({ min: -5 });
    // 値が 1 つもなくても、範囲を返す
    expect(thresholdSliderRange('unknownMetric', [])).toEqual({ min: 0, max: 2, step: 0.01 });
  });
});

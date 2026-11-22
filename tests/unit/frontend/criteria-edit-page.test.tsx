import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  at,
  callsOf,
  errorBody,
  renderApp,
} from '../../support/management-frontend.ts';

const BASE = {
  viewpointId: 'environmentalAdaptability',
  version: 'DEFAULT',
  isDefault: true,
  usesStatusIndicator: false,
  criteria: [
    {
      indicator: 'temperatureCelsius',
      kind: 'RANGE',
      label: '温度',
      thresholds: { errorLower: 5, normalLower: 15, normalUpper: 28, errorUpper: 35 },
    },
    {
      indicator: 'humidityPercent',
      kind: 'UPPER',
      label: '湿度',
      thresholds: { cautionFrom: 80, errorFrom: 90 },
    },
    {
      indicator: 'co2Ppm',
      kind: 'LOWER',
      label: 'CO2濃度',
      thresholds: { errorBelow: 200, cautionBelow: 300 },
    },
  ],
};
const CHANGED = {
  ...BASE,
  version: 'v2',
  isDefault: false,
  updatedBy: 'worker-1',
  updatedAt: '2026-10-09T02:00:00.000Z',
};
const PATH = '/viewpoints/environmentalAdaptability/criteria';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

function criterion(indicator: string): HTMLElement {
  return screen.getByTestId(`criterion-edit-${indicator}`);
}

describe('判断基準の編集（UC-19。SC-13）', () => {
  it('現在の判断基準を、指標ごとに、型・条件名・閾値（単位つき）で表示する。既定値のときは「既定値」', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });

    expect((await screen.findByTestId('criteria-state')).textContent).toBe('現在の状態: 既定値');
    const temperature = criterion('temperatureCelsius');
    expect(temperature.textContent).toContain('範囲型');
    expect(
      within(temperature).getByLabelText<HTMLInputElement>('異常下限（未満で異常）（℃）', {
        exact: false,
      }).value,
    ).toBe('5');
    expect(
      within(criterion('humidityPercent')).getByLabelText('注意開始値（以上で注意）（%）', {
        exact: false,
      }),
    ).toBeDefined();
    expect(
      within(criterion('co2Ppm')).getByLabelText('注意下限（未満で注意）（ppm）', { exact: false }),
    ).toBeDefined();
    expect(screen.queryByTestId('criteria-status-note')).toBeNull();
    // 既定値の間は、既定値へ戻す操作は選べない
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '既定値へ戻す' }).disabled).toBe(
      true,
    );
  });

  it('変更済みなら、版・変更者・変更日時を示す。ステータスコードでも判定する観点には、その旨と、ステータスコードへの案内を示す', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        jsonResponse({ ...CHANGED, usesStatusIndicator: true }),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toContain('変更済み');
    expect(state.textContent).toContain('版: v2');
    expect(state.textContent).toContain('変更者: worker-1');
    expect(state.textContent).toContain('2026');
    expect(
      within(screen.getByTestId('criteria-status-note')).getByRole('link').getAttribute('href'),
    ).toBe('/settings/status-codes');
  });

  it('変更者・変更日時が不明な変更済みの判断基準は、版だけを示す', async () => {
    const rest = Object.fromEntries(
      Object.entries(CHANGED).filter(([key]) => key !== 'updatedAt' && key !== 'updatedBy'),
    );
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(rest),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toContain('版: v2');
    expect(state.textContent).not.toContain('変更者');
  });

  it('権限（criteria:edit）がなければ、参照のみ。入力欄は読み取り専用で、保存・既定値へ戻す操作を表示しない', async () => {
    renderApp(
      PATH,
      { 'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CHANGED) },
      { login: READ_ONLY_LOGIN },
    );
    await screen.findByTestId('criteria-state');
    expect(screen.getByTestId('permission-notice').textContent).toContain('権限がありません');
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull();
    expect(
      within(criterion('humidityPercent')).getByLabelText<HTMLInputElement>('条件名', {
        exact: false,
      }).readOnly,
    ).toBe(true);
  });

  it('観点が存在しなければ、その旨を示し、API は呼ばない', async () => {
    const { calls } = renderApp('/viewpoints/unknown-viewpoint/criteria');
    expect((await screen.findByRole('alert')).textContent).toBe('観点が見つかりません');
    expect(callsOf(calls, 'GET', '/viewpoints/unknown-viewpoint/criteria')).toHaveLength(0);
  });

  it('取得に失敗した場合は、エラーを表示し、再読み込みできる', async () => {
    let failing = true;
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        failing ? errorBody(500, 'INTERNAL_ERROR', '取得できません') : jsonResponse(BASE),
    });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('取得できません');
    failing = false;
    fireEvent.click(at(screen.getAllByRole('button', { name: '再読み込み' }), 0));
    expect(await screen.findByTestId('criteria-state')).toBeDefined();
  });

  it('閾値・条件名を変更して保存すると、数値で送る。保存後は、変更済みとして読み直す', async () => {
    let saved = false;
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        jsonResponse(saved ? CHANGED : BASE),
      'PUT /viewpoints/environmentalAdaptability/criteria': () => {
        saved = true;
        return jsonResponse(CHANGED);
      },
    });
    await screen.findByTestId('criteria-state');
    const humidity = criterion('humidityPercent');
    fireEvent.change(
      within(humidity).getByLabelText('注意開始値（以上で注意）（%）', { exact: false }),
      { target: { value: '75.5' } },
    );
    fireEvent.change(within(humidity).getByLabelText('条件名', { exact: false }), {
      target: { value: '湿度（梅雨）' },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByTestId('criteria-notice')).textContent).toBe(
      '保存しました。現在の評価を更新しました',
    );
    const body = callsOf(calls, 'PUT', '/viewpoints/environmentalAdaptability/criteria')[0]
      ?.body as {
      criteria: { indicator: string; label: string; thresholds: Record<string, number> }[];
    };
    const sent = body.criteria.find((item) => item.indicator === 'humidityPercent');
    expect(sent?.thresholds).toEqual({ cautionFrom: 75.5, errorFrom: 90 });
    expect(sent?.label).toBe('湿度（梅雨）');
    await waitFor(() => {
      expect(screen.getByTestId('criteria-state').textContent).toContain('変更済み');
    });
  });

  it('不正な入力（空欄・数値でない値・大小関係・条件名）は、保存せず、項目ごとにエラーを表示する', async () => {
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });
    await screen.findByTestId('criteria-state');
    const humidity = criterion('humidityPercent');
    fireEvent.change(
      within(humidity).getByLabelText('注意開始値（以上で注意）（%）', { exact: false }),
      { target: { value: '' } },
    );
    fireEvent.change(
      within(humidity).getByLabelText('異常開始値（以上で異常）（%）', { exact: false }),
      { target: { value: 'abc' } },
    );
    fireEvent.change(within(humidity).getByLabelText('条件名', { exact: false }), {
      target: { value: '' },
    });
    const temperature = criterion('temperatureCelsius');
    fireEvent.change(
      within(temperature).getByLabelText('正常下限（以上で正常）（℃）', { exact: false }),
      { target: { value: '40' } },
    );
    const co2 = criterion('co2Ppm');
    fireEvent.change(within(co2).getByLabelText('条件名', { exact: false }), {
      target: { value: 'あ'.repeat(201) },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(await within(humidity).findByText('条件名は必須です')).toBeDefined();
    expect(within(humidity).getAllByText('閾値は数値で指定してください').length).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId('criterion-edit-temperatureCelsius')).getByTestId(
        'criterion-error-temperatureCelsius',
      ).textContent,
    ).toContain('異常下限 < 正常下限 < 正常上限 < 異常上限');
    expect(within(co2).getByText('条件名は200文字以内で指定してください')).toBeDefined();
    expect(callsOf(calls, 'PUT', '/viewpoints/environmentalAdaptability/criteria')).toHaveLength(0);
  });

  it('大小関係が成り立たない場合（上限型・下限型）は、保存せず、その指標にエラーを表示する', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });
    await screen.findByTestId('criteria-state');
    fireEvent.change(
      within(criterion('humidityPercent')).getByLabelText('注意開始値（以上で注意）（%）', {
        exact: false,
      }),
      { target: { value: '95' } },
    );
    fireEvent.change(
      within(criterion('co2Ppm')).getByLabelText('異常下限（未満で異常）（ppm）', { exact: false }),
      { target: { value: '400' } },
    );

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByTestId('criterion-error-humidityPercent')).textContent).toBe(
      '注意開始値は異常開始値より小さくしてください',
    );
    expect(screen.getByTestId('criterion-error-co2Ppm').textContent).toBe(
      '異常下限は注意下限より小さくしてください',
    );
  });

  it('サーバーのエラーは、画面に表示する', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
      'PUT /viewpoints/environmentalAdaptability/criteria': () =>
        errorBody(500, 'INTERNAL_ERROR', '保存できませんでした'),
    });
    await screen.findByTestId('criteria-state');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect((await screen.findByRole('alert')).textContent).toBe('保存できませんでした');
  });

  it('既定値へ戻す: 確認のダイアログ。キャンセルなら何もしない。確定すると、API を呼び、読み直す。失敗はエラーを表示する', async () => {
    let attempt = 0;
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CHANGED),
      'POST /viewpoints/environmentalAdaptability/criteria/reset': () => {
        attempt += 1;
        return attempt === 1
          ? errorBody(500, 'INTERNAL_ERROR', '戻せませんでした')
          : jsonResponse(BASE);
      },
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: 'キャンセル',
      }),
    );
    expect(
      callsOf(calls, 'POST', '/viewpoints/environmentalAdaptability/criteria/reset'),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '既定値へ戻す',
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe('戻せませんでした');

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '既定値へ戻す',
      }),
    );
    expect((await screen.findByTestId('criteria-notice')).textContent).toBe('既定値へ戻しました');
  });
});

describe('判断基準の編集: スライダー・帯・現在値と変更後の値（Issue #358）', () => {
  const ROUTE = { 'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE) };

  function slider(indicator: string, name: string): HTMLInputElement {
    return within(criterion(indicator)).getByRole<HTMLInputElement>('slider', { name });
  }

  function numberField(indicator: string, label: string): HTMLInputElement {
    return within(criterion(indicator)).getByLabelText<HTMLInputElement>(label, { exact: false });
  }

  function zoneLabels(testId: string): (string | null)[] {
    return Array.from(screen.getByTestId(testId).querySelectorAll('.zone-seg-label')).map(
      (node) => node.textContent,
    );
  }

  it('閾値ごとに、スライダー（範囲の目安・目盛り）と数値の欄を示す。スライダーの名前は、数値の欄のラベルと別（同じラベルが 2 つにならない）', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');

    const temperature = criterion('temperatureCelsius');
    expect(within(temperature).getAllByRole('slider')).toHaveLength(4);
    const lower = slider('temperatureCelsius', '異常下限のスライダー');
    expect([lower.min, lower.max, lower.step, lower.value]).toEqual(['-10', '50', '0.5', '5']);
    expect(slider('humidityPercent', '注意開始値のスライダー').max).toBe('100');
    // 数値の欄は、これまでどおり、ラベルで 1 つだけ見つかる
    expect(numberField('temperatureCelsius', '異常下限（未満で異常）（℃）').value).toBe('5');
  });

  it('範囲の目安・現在値・変更後の値を、単位つきで示す。変更していない間は「変更なし」', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');

    const metas = within(criterion('humidityPercent')).getAllByTestId('threshold-meta');
    expect(metas[0]?.textContent).toBe('目安の範囲: 0%〜100%現在値: 80%変更後: 80%（変更なし）');
    expect(
      within(criterion('temperatureCelsius')).getAllByTestId('threshold-meta')[0]?.textContent,
    ).toBe('目安の範囲: -10℃〜50℃現在値: 5℃変更後: 5℃（変更なし）');
  });

  it('スライダーを動かすと、数値の欄が連動し、変更後の値を示す。保存すると、その値を数値で送る', async () => {
    const { calls } = renderApp(PATH, {
      ...ROUTE,
      'PUT /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CHANGED),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.change(slider('humidityPercent', '注意開始値のスライダー'), {
      target: { value: '70' },
    });

    expect(numberField('humidityPercent', '注意開始値（以上で注意）').value).toBe('70');
    const meta = within(criterion('humidityPercent')).getAllByTestId('threshold-meta')[0];
    expect(meta?.textContent).toContain('現在値: 80%');
    expect(meta?.textContent).toContain('変更後: 70%');
    expect(meta?.textContent).not.toContain('変更なし');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await screen.findByTestId('criteria-notice');
    const body = callsOf(calls, 'PUT', '/viewpoints/environmentalAdaptability/criteria')[0]
      ?.body as { criteria: { indicator: string; thresholds: Record<string, number> }[] };
    expect(body.criteria.find((item) => item.indicator === 'humidityPercent')?.thresholds).toEqual({
      cautionFrom: 70,
      errorFrom: 90,
    });
  });

  it('小数の目盛り（0.5）でも、数値の欄に、浮動小数点の誤差のない値を入れる', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');

    fireEvent.change(slider('temperatureCelsius', '正常上限のスライダー'), {
      target: { value: '30.5' },
    });

    expect(numberField('temperatureCelsius', '正常上限（未満で正常）').value).toBe('30.5');
  });

  it('数値の欄に入力すると、スライダーが連動する。数値として読めない間は、スライダーは最小の位置で、変更後は「—」', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');
    const field = numberField('humidityPercent', '注意開始値（以上で注意）');

    fireEvent.change(field, { target: { value: '65' } });
    expect(slider('humidityPercent', '注意開始値のスライダー').value).toBe('65');

    fireEvent.change(field, { target: { value: 'abc' } });
    expect(slider('humidityPercent', '注意開始値のスライダー').value).toBe('0');
    expect(
      within(criterion('humidityPercent')).getAllByTestId('threshold-meta')[0]?.textContent,
    ).toContain('変更後: —');
    // 全角の数字も、数値として読む
    fireEvent.change(field, { target: { value: '７５' } });
    expect(slider('humidityPercent', '注意開始値のスライダー').value).toBe('75');
  });

  it('目安の範囲の外の値を入力すると、スライダーの範囲を、その値を含むまで広げる（入力は止めない）', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');

    fireEvent.change(numberField('temperatureCelsius', '異常上限（以上で異常）'), {
      target: { value: '62' },
    });

    expect(slider('temperatureCelsius', '異常上限のスライダー').max).toBe('62');
    expect(slider('temperatureCelsius', '異常下限のスライダー').max).toBe('62');
  });

  it('帯: 現在の判断基準を、正常・注意・異常に色分けして示す。変更すると、変更後の帯を並べる。元に戻すと、変更後の帯は消える', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');
    const current = screen.getByTestId('zone-current-humidityPercent');
    expect(screen.queryByTestId('zone-after-humidityPercent')).toBeNull();
    expect(current.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '現在の判断基準（正常: 80%未満、注意: 80%以上90%未満、異常: 90%以上）',
    );
    expect(zoneLabels('zone-current-humidityPercent')).toEqual(['正常', '注意', '異常']);

    const field = numberField('humidityPercent', '注意開始値（以上で注意）');
    fireEvent.change(field, { target: { value: '70' } });
    const after = screen.getByTestId('zone-after-humidityPercent');
    expect(after.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '変更後の判断基準（正常: 70%未満、注意: 70%以上90%未満、異常: 90%以上）',
    );

    fireEvent.change(field, { target: { value: '80' } });
    expect(screen.queryByTestId('zone-after-humidityPercent')).toBeNull();
  });

  it('範囲型の帯は、注意が 2 か所（5 区分）になる', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');

    expect(zoneLabels('zone-current-temperatureCelsius')).toEqual([
      '異常',
      '注意',
      '正常',
      '注意',
      '異常',
    ]);
  });

  it('大小関係が成り立たない入力の間は、変更後の帯を出さず、その旨を示す。保存の検証のエラーとは別の表示', async () => {
    renderApp(PATH, ROUTE);
    await screen.findByTestId('criteria-state');
    const field = numberField('humidityPercent', '注意開始値（以上で注意）');

    fireEvent.change(field, { target: { value: '95' } });

    expect(screen.queryByTestId('zone-after-humidityPercent')).toBeNull();
    expect(screen.getByTestId('zone-invalid-humidityPercent').textContent).toBe(
      '閾値の大小関係が整うまで、帯は表示しません',
    );
    expect(screen.queryByTestId('criterion-error-humidityPercent')).toBeNull();
    expect(screen.getByTestId('zone-current-humidityPercent')).toBeDefined();

    fireEvent.change(field, { target: { value: '85' } });
    expect(screen.queryByTestId('zone-invalid-humidityPercent')).toBeNull();
  });

  it('権限がなければ、スライダーは操作できない（無効）', async () => {
    renderApp(
      PATH,
      { 'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CHANGED) },
      { login: READ_ONLY_LOGIN },
    );
    await screen.findByTestId('criteria-state');

    const sliders = within(criterion('humidityPercent')).getAllByRole<HTMLInputElement>('slider');
    expect(sliders.map((control) => control.disabled)).toEqual([true, true]);
  });
});

describe('判断基準の編集: 単位のない指標（総合満足度）の閾値のラベル', () => {
  it('単位がなければ、ラベルに、単位の括弧を付けない（Issue #359）', async () => {
    renderApp('/viewpoints/satisfaction/criteria', {
      'GET /viewpoints/satisfaction/criteria': () =>
        jsonResponse({
          viewpointId: 'satisfaction',
          version: 'DEFAULT',
          isDefault: true,
          usesStatusIndicator: false,
          criteria: [
            {
              indicator: 'overallSatisfaction',
              kind: 'LOWER',
              label: '総合満足度',
              thresholds: { errorBelow: 3, cautionBelow: 4 },
            },
          ],
        }),
    });
    await screen.findByTestId('criteria-state');

    const card = screen.getByTestId('criterion-edit-overallSatisfaction');

    expect(
      within(card).getByLabelText<HTMLInputElement>('注意下限（未満で注意）', { exact: false })
        .value,
    ).toBe('4');
    expect(
      within(card).getByLabelText<HTMLInputElement>('異常下限（未満で異常）', { exact: false })
        .value,
    ).toBe('3');
  });
});

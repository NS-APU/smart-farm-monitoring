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

  it('変更済みなら、版・変更者・変更日時を示す。ステータスコードでも判定する観点には、その旨と、ステータスコード管理への案内を示す', async () => {
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

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultCriteria } from '../../../src/shared/constants/default-criteria.ts';
import type { ViewpointId } from '../../../src/shared/constants/viewpoints.ts';
import type { Criterion } from '../../../src/shared/schemas/criteria.ts';
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
const RESET_PATH = '/viewpoints/environmentalAdaptability/criteria/reset';

/** 版（ETag）つきの GET の応答。 */
function versioned(body: unknown, etag: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', etag },
  });
}

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

  it('変更済みなら、「変更済み」と最終変更（変更者・日時）を示し、内部の版は示さない。ステータスコードでも判定する観点には、その旨と、ステータスコードへの案内を示す', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        jsonResponse({ ...CHANGED, usesStatusIndicator: true }),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toContain('変更済み');
    expect(state.textContent).toContain('最終変更');
    expect(state.textContent).toContain('変更者: worker-1');
    expect(state.textContent).toContain('2026');
    expect(state.textContent).not.toContain('版');
    expect(state.textContent).not.toContain('v2');
    expect(
      within(screen.getByTestId('criteria-status-note')).getByRole('link').getAttribute('href'),
    ).toBe('/settings/status-codes');
  });

  it('最終変更の変更者は、「ユーザー名（ID）」で示す（SC-07-7）。ユーザー名がなければ（削除済みの利用者）、ID だけを示す', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        jsonResponse({ ...CHANGED, updatedByName: '作業者1' }),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toContain('変更者: 作業者1（worker-1）');
  });

  it('既定値のときは、「既定値」だけを示し、最終変更・版は示さない', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toBe('現在の状態: 既定値');
  });

  it('変更者・変更日時が不明な変更済みの判断基準は、「変更済み」だけを示す（最終変更・版は示さない）', async () => {
    const rest = Object.fromEntries(
      Object.entries(CHANGED).filter(([key]) => key !== 'updatedAt' && key !== 'updatedBy'),
    );
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(rest),
    });
    const state = await screen.findByTestId('criteria-state');
    expect(state.textContent).toBe('現在の状態: 変更済み');
  });

  it('条件名の入力欄の横に、説明のボタンがある。開くと、診断メッセージと判断基準の表で使う名前であることを示す', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });
    await screen.findByTestId('criteria-state');
    const card = criterion('temperatureCelsius');
    // 入力欄のラベルは、これまでどおり「条件名」（説明のボタンは、ラベルに混ざらない）
    expect(within(card).getByLabelText<HTMLInputElement>('条件名', { exact: false }).value).toBe(
      '温度',
    );

    fireEvent.click(within(card).getByRole('button', { name: '条件名の説明' }));

    const note = screen.getByRole('note');
    expect(note.textContent).toContain('診断メッセージ');
    expect(note.textContent).toContain('判断基準の表');
    expect(note.textContent).toContain('どの条件に当てはまったか');
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

describe('判断基準の編集: 版つき更新（SC-13-1。同時編集の検出）', () => {
  /** 他の管理者が先に変更した、あとの判断基準（湿度の注意開始値が 70）。 */
  const OTHER = {
    ...CHANGED,
    version: 'v3',
    updatedBy: 'worker-2',
    criteria: BASE.criteria.map((item) =>
      item.indicator === 'humidityPercent'
        ? { ...item, thresholds: { cautionFrom: 70, errorFrom: 90 } }
        : item,
    ),
  };
  const cautionFromOf = (): HTMLInputElement =>
    within(criterion('humidityPercent')).getByLabelText<HTMLInputElement>(
      '注意開始値（以上で注意）（%）',
      { exact: false },
    );

  it('保存は、読み込んだときの ETag を If-Match に付けて送る', async () => {
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => versioned(BASE, '"etag-1"'),
      'PUT /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(CHANGED),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    await screen.findByTestId('criteria-notice');
    expect(callsOf(calls, 'PUT', PATH).map((call) => call.ifMatch)).toEqual(['"etag-1"']);
  });

  it('既定値へ戻す操作も、読み込んだときの ETag を If-Match に付けて送る', async () => {
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => versioned(CHANGED, '"etag-2"'),
      'POST /viewpoints/environmentalAdaptability/criteria/reset': () => jsonResponse(BASE),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '既定値へ戻す',
      }),
    );

    await screen.findByTestId('criteria-notice');
    expect(callsOf(calls, 'POST', RESET_PATH).map((call) => call.ifMatch)).toEqual(['"etag-2"']);
  });

  it('保存が 409（他の管理者が先に変更）なら、その旨と「読み込み直す」を示す。読み込み直すと、最新の内容と版で、保存できる', async () => {
    let latest: 'mine' | 'other' = 'mine';
    const { calls } = renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        latest === 'mine' ? versioned(BASE, '"etag-1"') : versioned(OTHER, '"etag-3"'),
      'PUT /viewpoints/environmentalAdaptability/criteria': (request) => {
        if (request.ifMatch === '"etag-1"') {
          latest = 'other';
          return errorBody(409, 'CONFLICT', '他の管理者が変更しました。読み込み直してください');
        }
        return jsonResponse(OTHER);
      },
    });
    await screen.findByTestId('criteria-state');
    fireEvent.change(cautionFromOf(), { target: { value: '75' } });

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    const conflict = await screen.findByTestId('criteria-conflict');
    expect(conflict.getAttribute('role')).toBe('alert');
    expect(conflict.textContent).toContain('他の管理者が変更しました。読み込み直してください');
    expect(screen.queryByTestId('criteria-notice')).toBeNull();

    fireEvent.click(within(conflict).getByRole('button', { name: '読み込み直す' }));

    await waitFor(() => {
      expect(screen.getByTestId('criteria-state').textContent).toContain('変更者: worker-2');
    });
    expect(screen.queryByTestId('criteria-conflict')).toBeNull();
    expect(cautionFromOf().value).toBe('70');
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await screen.findByTestId('criteria-notice');
    expect(callsOf(calls, 'PUT', PATH).map((call) => call.ifMatch)).toEqual([
      '"etag-1"',
      '"etag-3"',
    ]);
  });

  it('既定値へ戻す操作が 409 でも、同じ案内を示す（確認のダイアログは閉じる）', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => versioned(CHANGED, '"etag-2"'),
      'POST /viewpoints/environmentalAdaptability/criteria/reset': () =>
        errorBody(409, 'CONFLICT', '他の管理者が変更しました。読み込み直してください'),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '既定値へ戻す',
      }),
    );

    const conflict = await screen.findByTestId('criteria-conflict');
    expect(within(conflict).getByRole('button', { name: '読み込み直す' })).toBeDefined();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('409 以外のエラーには、「読み込み直す」を示さない', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => versioned(BASE, '"etag-1"'),
      'PUT /viewpoints/environmentalAdaptability/criteria': () =>
        errorBody(500, 'INTERNAL_ERROR', '保存できませんでした'),
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect((await screen.findByRole('alert')).textContent).toBe('保存できませんでした');
    expect(screen.queryByTestId('criteria-conflict')).toBeNull();
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
    ).toBe('目安の範囲: -10℃〜50℃既定: 0℃（変更済み）現在値: 5℃変更後: 5℃（変更なし）');
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

describe('判断基準の編集: 既定値の併記（SC-13-3。Issue #165）', () => {
  /** 実際の既定値（観点ごと）に、編集画面の応答の項目を足したもの。 */
  function viewOf(viewpointId: ViewpointId, patch?: (criteria: Criterion[]) => Criterion[]) {
    const defaults = getDefaultCriteria(viewpointId);
    return {
      ...defaults,
      criteria: patch === undefined ? defaults.criteria : patch([...defaults.criteria]),
      usesStatusIndicator: false,
    };
  }

  function metaTexts(indicator: string): (string | null)[] {
    return within(criterion(indicator))
      .getAllByTestId('threshold-meta')
      .map((node) => node.textContent);
  }

  function defaultNotes(indicator: string): HTMLElement[] {
    return within(criterion(indicator)).getAllByTestId('threshold-default');
  }

  it('範囲型: 閾値ごとに、「既定: xx」を、単位つきで、閾値の入力の並び（異常下限・正常下限・正常上限・異常上限）で示す', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () =>
        jsonResponse(viewOf('environmentalAdaptability')),
    });
    await screen.findByTestId('criteria-state');

    expect(metaTexts('temperatureCelsius')).toEqual([
      '目安の範囲: -10℃〜50℃既定: 0℃現在値: 0℃変更後: 0℃（変更なし）',
      '目安の範囲: -10℃〜50℃既定: 10℃現在値: 10℃変更後: 10℃（変更なし）',
      '目安の範囲: -10℃〜50℃既定: 25℃現在値: 25℃変更後: 25℃（変更なし）',
      '目安の範囲: -10℃〜50℃既定: 35℃現在値: 35℃変更後: 35℃（変更なし）',
    ]);
    // 既定値のままなら、強調しない
    for (const note of defaultNotes('temperatureCelsius')) {
      expect(note.classList.contains('threshold-default-changed')).toBe(false);
    }
  });

  it('上限型: 注意開始値・異常開始値の既定を、単位つきで示す', async () => {
    renderApp('/viewpoints/harvestSpeed/criteria', {
      'GET /viewpoints/harvestSpeed/criteria': () => jsonResponse(viewOf('harvestSpeed')),
    });
    await screen.findByTestId('criteria-state');

    expect(defaultNotes('travelStoppedRatePercent').map((node) => node.textContent)).toEqual([
      '既定: 5%',
      '既定: 10%',
    ]);
    expect(defaultNotes('averageSecondsPerFruit').map((node) => node.textContent)).toEqual([
      '既定: 60秒/果実',
      '既定: 120秒/果実',
    ]);
  });

  it('下限型: 注意下限・異常下限の既定を示す。単位のない指標（総合満足度）は、単位を付けない', async () => {
    renderApp('/viewpoints/satisfaction/criteria', {
      'GET /viewpoints/satisfaction/criteria': () => jsonResponse(viewOf('satisfaction')),
    });
    await screen.findByTestId('criteria-state');

    expect(defaultNotes('overallSatisfaction').map((node) => node.textContent)).toEqual([
      '既定: 4',
      '既定: 3',
    ]);
  });

  it('既定値と違う閾値（変更済み）は、文字（「変更済み」）とアイコンで強調する。同じ閾値は、強調しない。入力で変えても、既定の表示は保存されている値で決まる', async () => {
    const changed = {
      ...viewOf('environmentalAdaptability', (criteria) =>
        criteria.map((item) =>
          item.indicator === 'temperatureCelsius' && item.kind === 'RANGE'
            ? { ...item, thresholds: { ...item.thresholds, normalLower: 15 } }
            : item,
        ),
      ),
      version: 'v2',
      isDefault: false,
    };
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(changed),
    });
    await screen.findByTestId('criteria-state');

    const notes = defaultNotes('temperatureCelsius');
    expect(notes.map((node) => node.textContent)).toEqual([
      '既定: 0℃',
      '既定: 10℃（変更済み）',
      '既定: 25℃',
      '既定: 35℃',
    ]);
    expect(notes.map((node) => node.classList.contains('threshold-default-changed'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // アイコン（装飾。読み上げの対象外）は、変更済みの閾値だけ
    expect(notes.map((node) => node.querySelector('svg[aria-hidden="true"]') !== null)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // ほかの指標（既定のまま）は、強調しない
    for (const note of defaultNotes('humidityPercent')) {
      expect(note.classList.contains('threshold-default-changed')).toBe(false);
    }

    // 入力で変えても（まだ保存していない）、既定の表示・強調は、保存されている値で決まる
    fireEvent.change(
      within(criterion('temperatureCelsius')).getByLabelText('正常下限（以上で正常）', {
        exact: false,
      }),
      { target: { value: '10' } },
    );
    expect(metaTexts('temperatureCelsius')[1]).toBe(
      '目安の範囲: -10℃〜50℃既定: 10℃（変更済み）現在値: 15℃変更後: 10℃',
    );
  });

  it('既定値へ戻した後は、強調が消える（読み直した判断基準が、既定値）', async () => {
    const changed = {
      ...viewOf('harvestAccuracy', (criteria) =>
        criteria.map((item) =>
          item.indicator === 'marketableFruitRatePercent' && item.kind === 'LOWER'
            ? { ...item, thresholds: { ...item.thresholds, cautionBelow: 85 } }
            : item,
        ),
      ),
      version: 'v2',
      isDefault: false,
    };
    let reset = false;
    renderApp('/viewpoints/harvestAccuracy/criteria', {
      'GET /viewpoints/harvestAccuracy/criteria': () =>
        jsonResponse(reset ? viewOf('harvestAccuracy') : changed),
      'POST /viewpoints/harvestAccuracy/criteria/reset': () => {
        reset = true;
        return jsonResponse(viewOf('harvestAccuracy'));
      },
    });
    await screen.findByTestId('criteria-state');
    expect(defaultNotes('marketableFruitRatePercent').map((node) => node.textContent)).toEqual([
      '既定: 90%（変更済み）',
      '既定: 80%',
    ]);

    fireEvent.click(screen.getByRole('button', { name: '既定値へ戻す' }));
    fireEvent.click(
      within(await screen.findByTestId('confirm-dialog')).getByRole('button', {
        name: '既定値へ戻す',
      }),
    );
    expect((await screen.findByTestId('criteria-notice')).textContent).toBe('既定値へ戻しました');

    await waitFor(() => {
      expect(defaultNotes('marketableFruitRatePercent').map((node) => node.textContent)).toEqual([
        '既定: 90%',
        '既定: 80%',
      ]);
    });
  });

  it('参照のみの利用者（権限なし）にも、既定を示す', async () => {
    renderApp(
      PATH,
      {
        'GET /viewpoints/environmentalAdaptability/criteria': () =>
          jsonResponse(viewOf('environmentalAdaptability')),
      },
      { login: READ_ONLY_LOGIN },
    );
    await screen.findByTestId('criteria-state');

    expect(defaultNotes('co2Ppm')).toHaveLength(4);
  });

  it('既定値の指標・型と合わない判断基準には、既定を示さない（比べる既定がない）', async () => {
    renderApp(PATH, {
      'GET /viewpoints/environmentalAdaptability/criteria': () => jsonResponse(BASE),
    });
    await screen.findByTestId('criteria-state');

    // BASE の湿度は上限型（既定は範囲型）
    expect(within(criterion('humidityPercent')).queryAllByTestId('threshold-default')).toHaveLength(
      0,
    );
    expect(metaTexts('humidityPercent')[0]).toBe(
      '目安の範囲: 0%〜100%現在値: 80%変更後: 80%（変更なし）',
    );
  });
});

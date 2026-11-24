import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultCriteria } from '../../../src/shared/constants/default-criteria.ts';
import { toEquipmentId } from '../../../src/shared/schemas/common.ts';
import type { CriteriaPreviewResponse } from '../../../src/shared/schemas/criteria.ts';
import { jsonResponse } from '../../support/frontend.ts';
import {
  READ_ONLY_LOGIN,
  callsOf,
  errorBody,
  renderApp,
} from '../../support/management-frontend.ts';

/**
 * 判断基準の編集（SC-13）の「影響を確認」（SC-13-2。Issue #165。ADR-0017 の D-24）。
 * 入力途中の閾値を、保存済みの評価結果に当てて、状態が変わる設備を確認する（自動では実行しない。保存しない）。
 */

const VIEWPOINT = 'environmentalAdaptability';
const PATH = `/viewpoints/${VIEWPOINT}/criteria`;
const PREVIEW_PATH = `${PATH}/preview`;
const CRITERIA = { ...getDefaultCriteria(VIEWPOINT), usesStatusIndicator: false };

const EMPTY: CriteriaPreviewResponse = {
  viewpointId: VIEWPOINT,
  evaluatedAt: '2026-10-09T02:57:00.000Z',
  targetCount: 3,
  changes: [],
  unevaluated: [],
  unknownCount: 0,
};
const CHANGED: CriteriaPreviewResponse = {
  ...EMPTY,
  changes: [
    {
      equipmentId: toEquipmentId('HOUSE-01'),
      equipmentName: '第 1 ハウス',
      equipmentType: 'FACILITY',
      current: 'CAUTION',
      after: 'NORMAL',
    },
    {
      equipmentId: toEquipmentId('SENSOR-01'),
      equipmentName: '温度センサー',
      equipmentType: 'SENSOR',
      current: 'ERROR',
      after: 'CAUTION',
    },
  ],
};

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

/** 温度（範囲型）の正常上限の入力欄。 */
const normalUpper = () =>
  within(screen.getByTestId('criterion-edit-temperatureCelsius')).getByLabelText(
    '正常上限（未満で正常）',
    { exact: false },
  );
const previewButton = () => screen.getByRole<HTMLButtonElement>('button', { name: '影響を確認' });

function open(preview: () => Response, options?: { readOnly?: boolean }) {
  return renderApp(
    PATH,
    {
      [`GET ${PATH}`]: () => jsonResponse(CRITERIA),
      [`POST ${PREVIEW_PATH}`]: preview,
    },
    options?.readOnly === true ? { login: READ_ONLY_LOGIN } : {},
  );
}

describe('判断基準の影響の確認（SC-13-2）', () => {
  it('「影響を確認」を押すまで、実行しない（画面を開いても、入力を変えても、API を呼ばない）', async () => {
    const { calls } = open(() => jsonResponse(EMPTY));
    await screen.findByTestId('criteria-state');

    fireEvent.change(normalUpper(), {
      target: { value: '30' },
    });

    expect(callsOf(calls, 'POST', PREVIEW_PATH)).toHaveLength(0);
    expect(screen.queryByTestId('criteria-preview-notice')).toBeNull();
  });

  it('押すと、入力途中の閾値を送り（保存はしない）、状態が変わる設備だけを、「現在」と「変更後」の状態（文字つき）で一覧にする。件数を示す', async () => {
    const { calls } = open(() => jsonResponse(CHANGED));
    await screen.findByTestId('criteria-state');
    fireEvent.change(normalUpper(), {
      target: { value: '30' },
    });

    fireEvent.click(previewButton());

    expect((await screen.findByTestId('criteria-preview-notice')).textContent).toBe(
      '状態が変わる設備: 2 件',
    );
    const sent = callsOf(calls, 'POST', PREVIEW_PATH);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.body)).toContain('"normalUpper":30');
    // 判断基準は、保存しない（PUT を呼ばない）
    expect(callsOf(calls, 'PUT', PATH)).toHaveLength(0);
    const house = screen.getByTestId('criteria-preview-row-HOUSE-01');
    expect(within(house).getByText('第 1 ハウス')).toBeDefined();
    expect(house.textContent).toContain('注意');
    expect(house.textContent).toContain('正常');
    const sensor = screen.getByTestId('criteria-preview-row-SENSOR-01');
    expect(sensor.textContent).toContain('異常');
    expect(sensor.textContent).toContain('注意');
    // 列の見出し（狭い幅のカードの項目名）
    expect(
      within(screen.getByTestId('criteria-preview-table'))
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['設備', '現在', '変更後']);
  });

  it('保存済みの評価結果に対する影響であること（最大約 5 分前・保存後の評価で結果が変わりうること・AWS では定期の評価）を、結果の近くに明記する。評価日時も示す', async () => {
    open(() => jsonResponse(CHANGED));
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());
    await screen.findByTestId('criteria-preview-notice');

    const basis = screen.getByTestId('criteria-preview-basis').textContent;
    expect(basis).toContain('保存済みの評価結果に対する影響');
    expect(basis).toContain('最大約 5 分前');
    expect(basis).toContain('新しいデータにより、結果が変わることがあります');
    expect(basis).toContain('定期の評価');
    expect(basis).toContain('評価日時');
  });

  it('変わる設備がないときは、「変わる設備はありません」と示す（表は出さない）', async () => {
    open(() => jsonResponse(EMPTY));
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());

    expect((await screen.findByTestId('criteria-preview-notice')).textContent).toBe(
      '変わる設備はありません',
    );
    expect(screen.queryByTestId('criteria-preview-table')).toBeNull();
  });

  it('対象の設備がないとき（閲覧できる設備がない・対象の設備が未登録）は、「変わる設備はありません」とは言わず、確認できる設備がない旨を示す', async () => {
    open(() => jsonResponse({ ...EMPTY, targetCount: 0, evaluatedAt: null }));
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());

    expect((await screen.findByTestId('criteria-preview-notice')).textContent).toBe(
      '確認できる設備がありません',
    );
  });

  it('未評価の設備（保存済みの結果がない）は、一覧と区別して、名前を示す。「不明」の設備は、閾値を変えても「不明」のままである旨と件数を示す', async () => {
    open(() =>
      jsonResponse({
        ...CHANGED,
        unevaluated: [
          { equipmentId: 'SENSOR-NEW', equipmentName: '新しいセンサー', equipmentType: 'SENSOR' },
        ],
        unknownCount: 2,
      }),
    );
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());
    await screen.findByTestId('criteria-preview-notice');

    const unevaluated = screen.getByTestId('criteria-preview-unevaluated');
    expect(unevaluated.textContent).toContain('未評価');
    expect(unevaluated.textContent).toContain('新しいセンサー');
    // 一覧（状態が変わる設備の表）には、含めない
    expect(screen.queryByTestId('criteria-preview-row-SENSOR-NEW')).toBeNull();
    const unknown = screen.getByTestId('criteria-preview-unknown').textContent;
    expect(unknown).toContain('2 件');
    expect(unknown).toContain('「不明」のまま');
  });

  it('入力が不正なとき（大小関係が成り立たない）は、API を呼ばず、保存と同じメッセージで示す', async () => {
    const { calls } = open(() => jsonResponse(EMPTY));
    await screen.findByTestId('criteria-state');
    // 正常下限 > 正常上限
    fireEvent.change(normalUpper(), {
      target: { value: '5' },
    });

    fireEvent.click(previewButton());

    const error = await screen.findByTestId('criterion-error-temperatureCelsius');
    expect(error.textContent).toContain('異常下限 < 正常下限 < 正常上限 < 異常上限');
    expect(callsOf(calls, 'POST', PREVIEW_PATH)).toHaveLength(0);
    // 保存を押したときと、同じメッセージ
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect((await screen.findByTestId('criterion-error-temperatureCelsius')).textContent).toContain(
      '異常下限 < 正常下限 < 正常上限 < 異常上限',
    );
  });

  it('サーバーが検証エラー・エラーを返したときは、その項目・メッセージを示す。結果は出さない', async () => {
    let attempt = 0;
    open(() => {
      attempt += 1;
      return attempt === 1
        ? errorBody(400, 'VALIDATION_ERROR', '入力内容を確認してください', [
            { name: 'criteria.0.thresholds', message: 'サーバーの検証のメッセージ' },
          ])
        : errorBody(500, 'INTERNAL_ERROR', '確認できませんでした');
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());
    expect((await screen.findByTestId('criterion-error-temperatureCelsius')).textContent).toContain(
      'サーバーの検証のメッセージ',
    );
    expect(screen.queryByTestId('criteria-preview-notice')).toBeNull();

    fireEvent.click(previewButton());
    expect((await screen.findByRole('alert')).textContent).toBe('確認できませんでした');
  });

  it('確認の後に入力を変えたら、結果を消す（古い結果を、新しい入力のものとして示さない）', async () => {
    open(() => jsonResponse(CHANGED));
    await screen.findByTestId('criteria-state');
    fireEvent.click(previewButton());
    await screen.findByTestId('criteria-preview-notice');

    fireEvent.change(normalUpper(), {
      target: { value: '31' },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('criteria-preview-notice')).toBeNull();
    });
  });

  it('確認中は、ボタンを押せず、「確認中…」と示す（二重に実行しない）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = renderApp(PATH, {
      [`GET ${PATH}`]: () => jsonResponse(CRITERIA),
      [`POST ${PREVIEW_PATH}`]: async () => {
        await gate;
        return jsonResponse(EMPTY);
      },
    });
    await screen.findByTestId('criteria-state');

    fireEvent.click(previewButton());

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認中…' }).disabled).toBe(
        true,
      );
    });
    release?.();
    await screen.findByTestId('criteria-preview-notice');
    expect(callsOf(calls, 'POST', PREVIEW_PATH)).toHaveLength(1);
  });

  it('編集の権限がない利用者には、「影響を確認」を出さない（サーバー側でも拒否する）', async () => {
    open(() => jsonResponse(EMPTY), { readOnly: true });
    await screen.findByTestId('criteria-state');

    expect(screen.queryByRole('button', { name: '影響を確認' })).toBeNull();
  });
});

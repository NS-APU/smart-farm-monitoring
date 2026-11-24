/**
 * 計測データ（SC-09）の「評価に使われていません」の印（D-26。Issue #162 の SC-09-4）の単体テスト。
 * 合計（累積）の項目の手動入力の行で、評価の期間に自動取り込みの値があり、評価に使われないものに、タグを付ける。
 * ヘルプヒントで、「この期間は自動取り込みの値を使うため」と説明する。計測ごとの一覧・項目ごとの一覧の両方。
 * 判定は API（`usage`。`includeUsage=true` のときだけ付く）が行い、画面は、応答の `usage` を表示する。
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  EvaluationUsage,
  Measurement,
  ObservationRow,
} from '../../../src/shared/schemas/observation.ts';
import { jsonResponse } from '../../support/frontend.ts';
import { at, callsOf, renderApp } from '../../support/management-frontend.ts';

const ALL_PERIODS: EvaluationUsage['autoPriorityPeriods'] = [
  { horizon: 'SHORT', periodDays: null },
  { horizon: 'LONG', periodDays: 1 },
  { horizon: 'LONG', periodDays: 7 },
  { horizon: 'LONG', periodDays: 30 },
  { horizon: 'LONG', periodDays: 60 },
  { horizon: 'LONG', periodDays: 90 },
];

const NOT_USED: EvaluationUsage = { used: false, autoPriorityPeriods: ALL_PERIODS };
const USED: EvaluationUsage = { used: true, autoPriorityPeriods: [] };
const PARTIAL: EvaluationUsage = { used: true, autoPriorityPeriods: ALL_PERIODS.slice(2) };

const TAG = '評価に使われていません';
const TAG_PARTIAL = '一部の評価に使われていません';

function row(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    equipmentId: 'ROBOT-01' as ObservationRow['equipmentId'],
    category: 'HARVEST',
    itemKey: 'harvestCount',
    observedAt: '2026-10-09T02:00:00.000Z',
    value: 1700,
    source: 'MANUAL',
    quality: 'VALID',
    receivedAt: '2026-10-09T02:01:00.000Z',
    manualEntryId: 'entry-1',
    isDeleted: false,
    ...overrides,
  };
}

function measurement(items: ObservationRow[], overrides: Partial<Measurement> = {}): Measurement {
  return {
    equipmentId: 'ROBOT-01' as Measurement['equipmentId'],
    observedAt: '2026-10-09T02:00:00.000Z',
    source: 'MANUAL',
    manualEntryId: 'entry-1',
    receivedAt: '2026-10-09T02:01:00.000Z',
    items,
    ...overrides,
  };
}

const measurementsRoute = (items: Measurement[]) => ({
  'GET /observations/measurements': () => jsonResponse({ items, nextCursor: null }),
});
const itemsRoute = (items: ObservationRow[]) => ({
  'GET /observations': () => jsonResponse({ items, nextCursor: null }),
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState(null, '', '/');
});

describe('計測ごとの一覧: 「評価に使われていません」のタグ', () => {
  it('自動取り込みの値を使うため評価に使われない項目に、タグを付ける。使われる項目・合計でない項目・自動取り込みの計測には付けない', async () => {
    renderApp(
      '/observations',
      measurementsRoute([
        measurement([
          row({ itemKey: 'harvestCount', usage: NOT_USED }),
          row({ itemKey: 'operatingHours', value: 6, usage: USED }),
          row({ itemKey: 'failureCount', category: 'FAILURE', value: 1 }),
        ]),
        measurement([row({ itemKey: 'harvestCount', source: 'AUTO_IMPORT' })], {
          source: 'AUTO_IMPORT',
          observedAt: '2026-10-09T01:00:00.000Z',
        }),
      ]),
    );

    const items = await screen.findAllByTestId('measurement-item');

    expect(items).toHaveLength(4);
    expect(within(at(items, 0)).getByTestId('usage-tag').textContent).toContain(TAG);
    expect(within(at(items, 1)).queryByTestId('usage-tag')).toBeNull();
    expect(within(at(items, 2)).queryByTestId('usage-tag')).toBeNull();
    expect(within(at(items, 3)).queryByTestId('usage-tag')).toBeNull();
    expect(screen.getAllByTestId('usage-tag')).toHaveLength(1);
  });

  it('ヘルプヒントで、「この期間は自動取り込みの値を使うため」と説明する（タップ・クリックで開閉できる）', async () => {
    renderApp('/observations', measurementsRoute([measurement([row({ usage: NOT_USED })])]));
    const tag = await screen.findByTestId('usage-tag');

    const button = within(tag).getByRole('button', { name: '評価での扱いの説明' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(within(tag).getByRole('note').textContent).toBe(
      'この期間は自動取り込みの値を使うため、この入力は評価に使われません',
    );
    fireEvent.click(button);
    expect(within(tag).queryByRole('note')).toBeNull();
  });

  it('評価の期間によって取得元が変わるときは、「一部の評価に使われていません」とし、自動取り込みの値を使う期間を示す', async () => {
    renderApp('/observations', measurementsRoute([measurement([row({ usage: PARTIAL })])]));
    const tag = await screen.findByTestId('usage-tag');

    expect(tag.textContent).toContain(TAG_PARTIAL);
    fireEvent.click(within(tag).getByRole('button', { name: '評価での扱いの説明' }));
    expect(within(tag).getByRole('note').textContent).toBe(
      '長期視点（直近7日）・長期視点（直近30日）・長期視点（直近60日）・長期視点（直近90日）の評価では、自動取り込みの値を使うため、この入力は使われません',
    );
  });

  it('API には、includeUsage=true を付けて読む', async () => {
    const { calls } = renderApp('/observations', measurementsRoute([measurement([row()])]));
    await screen.findAllByTestId('measurement-item');

    expect(callsOf(calls, 'GET', '/observations/measurements')[0]?.query.get('includeUsage')).toBe(
      'true',
    );
  });
});

describe('項目ごとの一覧: 「評価に使われていません」のタグ', () => {
  it('評価に使われない手動入力の行に、タグを付ける。使われる行・自動取り込みの行・usage のない行には付けない', async () => {
    renderApp(
      '/observations?sort=category&from=2026-10-01&to=2026-10-09',
      itemsRoute([
        row({ usage: NOT_USED }),
        row({ usage: USED, itemKey: 'operatingHours' }),
        row({ source: 'AUTO_IMPORT', manualEntryId: undefined }),
        row({ itemKey: 'temperatureCelsius', category: 'ENVIRONMENT', value: 25 }),
        row({ usage: PARTIAL, itemKey: 'standbyHours' }),
      ]),
    );

    const rows = await screen.findAllByTestId('observation-row');

    expect(rows).toHaveLength(5);
    expect(within(at(rows, 0)).getByTestId('usage-tag').textContent).toContain(TAG);
    expect(within(at(rows, 1)).queryByTestId('usage-tag')).toBeNull();
    expect(within(at(rows, 2)).queryByTestId('usage-tag')).toBeNull();
    expect(within(at(rows, 3)).queryByTestId('usage-tag')).toBeNull();
    expect(within(at(rows, 4)).getByTestId('usage-tag').textContent).toContain(TAG_PARTIAL);
    fireEvent.click(within(at(rows, 0)).getByRole('button', { name: '評価での扱いの説明' }));
    expect(within(at(rows, 0)).getByRole('note').textContent).toContain(
      'この期間は自動取り込みの値を使うため',
    );
  });

  it('API には、includeUsage=true を付けて読む', async () => {
    const { calls } = renderApp(
      '/observations?sort=category&from=2026-10-01&to=2026-10-09',
      itemsRoute([row()]),
    );
    await screen.findAllByTestId('observation-row');

    expect(callsOf(calls, 'GET', '/observations')[0]?.query.get('includeUsage')).toBe('true');
  });
});

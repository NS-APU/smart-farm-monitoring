/**
 * 変更履歴（SC-08）の、変更点の印（Issue #190。SC-08-5）。変更前後の値は、全項目を残したまま、値が変わった項目に「変更」、
 * 追加された項目に「追加」、なくなった項目に「なし」の印（文字つきのタグ。太字・枠線は CSS）を付ける。登録・削除には付けない。
 * 設備・ステータスコードなど（内容を開いて確認する種類）は、閉じた状態でも、変わった項目名を 1 行で示す。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultCriteria } from '../../../src/shared/constants/default-criteria.ts';
import { jsonResponse } from '../../support/frontend.ts';
import { at, renderApp } from '../../support/management-frontend.ts';

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

const BASE = {
  auditId: 'a-1',
  occurredAt: '2026-11-25T02:00:00.000Z',
  operation: 'UPDATE',
  targetType: 'manual-entry',
  targetId: 'e-1',
  actor: 'worker-1',
};

async function renderRows(items: readonly Record<string, unknown>[]): Promise<HTMLElement[]> {
  renderApp('/data-entry/history', {
    'GET /audit-logs': () => jsonResponse({ items, nextCursor: null }),
  });
  return await screen.findAllByTestId('audit-row');
}

function cellsOf(row: HTMLElement): { before: HTMLElement; after: HTMLElement } {
  const cells = Array.from(row.querySelectorAll('td'));
  return { before: at(cells, 4), after: at(cells, 5) };
}

function marksIn(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('.diff-mark')).map((mark) => mark.textContent);
}

function lineOf(element: HTMLElement, text: string): HTMLElement {
  const found = Array.from(
    element.querySelectorAll<HTMLElement>('li, div.audit-field, dl.audit-meta > div'),
  ).find((candidate) => candidate.textContent.includes(text));
  if (found === undefined) {
    throw new Error(`「${text}」を含む行がありません`);
  }
  return found;
}

describe('手動入力: 項目と、計測日時・設備・カテゴリ・備考を、項目単位で比べて印を付ける', () => {
  const entry = {
    ...BASE,
    before: {
      items: { failureCount: 1, repairMinutes: 30, remarks: 'x' },
      observedAt: '2026-11-25T01:00:00.000Z',
      equipmentId: 'ROBOT-01',
      category: 'FAILURE',
      note: '修正前の備考',
    },
    after: {
      items: { failureCount: 2, repairMinutes: 30, newItem: 5 },
      observedAt: '2026-11-25T01:00:00Z',
      equipmentId: 'ROBOT-02',
      category: 'FAILURE',
      note: '',
    },
  };

  it('値が変わった項目に「変更」（変更前・変更後の両方）。変わらない項目には、印を付けない（日時の表記ゆれも、変更にしない）', async () => {
    const { before, after } = cellsOf(at(await renderRows([entry]), 0));

    expect(lineOf(before, '故障回数').querySelector('.diff-mark')?.textContent).toBe('変更');
    expect(lineOf(after, '故障回数').querySelector('.diff-mark')?.textContent).toBe('変更');
    expect(lineOf(before, 'repairMinutes').querySelector('.diff-mark')).toBeNull();
    expect(lineOf(after, 'repairMinutes').querySelector('.diff-mark')).toBeNull();
    expect(lineOf(before, '設備').querySelector('.diff-mark')?.textContent).toBe('変更');
    expect(lineOf(after, '設備').querySelector('.diff-mark')?.textContent).toBe('変更');
    // 計測日時は、小数秒の有無だけが違う（同じ時刻）
    expect(lineOf(before, '計測日時').querySelector('.diff-mark')).toBeNull();
    expect(lineOf(after, 'カテゴリ').querySelector('.diff-mark')).toBeNull();
  });

  it('追加された項目は、変更後に「追加」。なくなった項目は、変更後に「なし」（値は示さない）。変更前には付けない', async () => {
    const { before, after } = cellsOf(at(await renderRows([entry]), 0));

    expect(lineOf(after, 'newItem').querySelector('.diff-mark')?.textContent).toBe('追加');
    expect(lineOf(after, 'remarks').querySelector('.diff-mark')?.textContent).toBe('なし');
    expect(lineOf(after, 'remarks').textContent).not.toContain('x');
    expect(lineOf(after, '備考').querySelector('.diff-mark')?.textContent).toBe('なし');
    expect(lineOf(before, 'remarks').querySelector('.diff-mark')).toBeNull();
    expect(before.textContent).not.toContain('newItem');
    expect(marksIn(before)).toEqual(['変更', '変更']);
  });

  it('印は、文字のタグ（色だけに頼らない）。状態の色（正常・注意・異常）の部品は使わない', async () => {
    const { after } = cellsOf(at(await renderRows([entry]), 0));

    const mark = after.querySelector('.diff-mark');

    expect(mark?.tagName).toBe('SPAN');
    expect(mark?.textContent).not.toBe('');
    expect(after.querySelector('.status-badge')).toBeNull();
  });

  it('狭い幅のカードでも、同じ印を付ける（同じセル。項目名 data-label は、列の見出し）', async () => {
    const row = at(await renderRows([entry]), 0);

    const afterCell = row.querySelector('td[data-label="変更後"]');

    expect(afterCell).not.toBeNull();
    expect(marksIn(afterCell as HTMLElement)).toEqual(['変更', '追加', 'なし', '変更', 'なし']);
  });

  it('登録（変更前なし）・削除（変更後なし）には、印を付けない（操作種別だけで示す）', async () => {
    const rows = await renderRows([
      { ...BASE, auditId: 'c', operation: 'CREATE', before: undefined, after: entry.after },
      { ...BASE, auditId: 'd', operation: 'DELETE', before: entry.before, after: undefined },
    ]);

    for (const row of rows) {
      expect(marksIn(row)).toEqual([]);
    }
    expect(at(rows, 0).textContent).toContain('登録');
    expect(at(rows, 1).textContent).toContain('削除');
  });

  it('変わった項目がなければ、印を付けない', async () => {
    const { before, after } = cellsOf(at(await renderRows([{ ...entry, after: entry.before }]), 0));

    expect(marksIn(before)).toEqual([]);
    expect(marksIn(after)).toEqual([]);
  });
});

describe('設備・ステータスコードなど: 内容を開く中の項目に印。閉じた状態でも、変わった項目名を 1 行で示す', () => {
  const equipment = {
    equipmentId: 'ROBOT-01',
    equipmentType: 'ROBOT',
    name: '収穫ロボット1',
    facilityId: 'HOUSE-01',
    sourceFilePath: '/data/robot-01.json',
    intervalMinutes: 1,
    isDeleted: false,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const update = {
    ...BASE,
    targetType: 'equipment',
    targetId: 'ROBOT-01',
    before: equipment,
    after: { ...equipment, name: '収穫ロボット2', intervalMinutes: 5, externalId: 'R1' },
  };

  it('閉じた状態で、変わった項目名（画面の呼び方）を 1 行で示す。変更・追加を分けて示す', async () => {
    const { before, after } = cellsOf(at(await renderRows([update]), 0));

    const line = after.querySelector('.audit-changes');

    expect(line?.textContent).toBe('変更: 名称・取得間隔　追加: データ上の識別子');
    expect(before.querySelector('.audit-changes')).toBeNull();
    expect(after.querySelector('details')?.open).toBe(false);
  });

  it('内容の中で、変わった項目に印を付ける。変わらない項目は、通常の表示（全項目が残る）', async () => {
    const { before, after } = cellsOf(at(await renderRows([update]), 0));

    const nameField = lineOf(after, '"name": "収穫ロボット2"');

    expect(nameField.querySelector('.diff-mark')?.textContent).toBe('変更');
    expect(lineOf(before, '"name": "収穫ロボット1"').querySelector('.diff-mark')?.textContent).toBe(
      '変更',
    );
    expect(lineOf(after, '"intervalMinutes": 5').querySelector('.diff-mark')?.textContent).toBe(
      '変更',
    );
    expect(lineOf(after, '"externalId": "R1"').querySelector('.diff-mark')?.textContent).toBe(
      '追加',
    );
    const unchanged = lineOf(after, '"equipmentId": "ROBOT-01"');
    expect(unchanged.querySelector('.diff-mark')).toBeNull();
    expect(after.querySelectorAll('.audit-json')).toHaveLength(9);
    expect(before.querySelectorAll('.audit-json')).toHaveLength(8);
  });

  it('なくなった項目は、変更後に「なし」（値は示さない）。要約にも「なし」として示す', async () => {
    const { after } = cellsOf(
      at(
        await renderRows([
          {
            ...update,
            after: { ...equipment, intervalMinutes: undefined, sourceFilePath: undefined },
          },
        ]),
        0,
      ),
    );

    expect(after.querySelector('.audit-changes')?.textContent).toBe('なし: ファイルパス・取得間隔');
    expect(marksIn(after)).toEqual(['なし', 'なし']);
    expect(after.textContent).not.toContain('/data/robot-01.json');
  });

  it('変わった項目がなければ、その旨を示す。印は付けない', async () => {
    const { after } = cellsOf(at(await renderRows([{ ...update, after: equipment }]), 0));

    expect(after.querySelector('.audit-changes')?.textContent).toBe('変更された項目はありません');
    expect(marksIn(after)).toEqual([]);
  });

  it('登録・削除、片方だけの記録（認証情報の更新）には、印も要約も付けない。内容は、これまでどおり JSON', async () => {
    const rows = await renderRows([
      { ...update, auditId: 'c', operation: 'CREATE', before: undefined, after: equipment },
      { ...update, auditId: 'd', operation: 'DELETE', before: equipment, after: undefined },
      {
        ...update,
        auditId: 'e',
        targetType: 'ingestion-settings',
        before: undefined,
        after: { credentialsUpdated: true, authMethod: 'BASIC' },
      },
    ]);

    for (const row of rows) {
      expect(row.querySelector('.diff-mark')).toBeNull();
      expect(row.querySelector('.audit-changes')).toBeNull();
    }
    expect(at(rows, 0).querySelector('pre')?.textContent).toContain('"name": "収穫ロボット1"');
  });

  it('ステータスコード: カテゴリの変更だけに印。表示の JSON のキーは、そのまま読める', async () => {
    const code = { code: 'CHARGING', name: '充電中', category: 'NORMAL', isDeleted: false };
    const { before, after } = cellsOf(
      at(
        await renderRows([
          {
            ...BASE,
            targetType: 'status-code',
            targetId: 'CHARGING',
            before: code,
            after: { ...code, category: 'CAUTION' },
          },
        ]),
        0,
      ),
    );

    expect(after.querySelector('.audit-changes')?.textContent).toBe('変更: カテゴリ');
    expect(marksIn(before)).toEqual(['変更']);
    expect(after.textContent).toContain('"category": "CAUTION"');
  });

  it('ユーザー: 名前・ロールの変更とパスワードの変更。閲覧の割り当て: ユーザーの順序違いは、変更にしない', async () => {
    const user = { userId: 'worker-1', userName: '作業者1', role: 'general' };
    const rows = await renderRows([
      {
        ...BASE,
        auditId: 'u',
        targetType: 'user',
        before: user,
        after: { ...user, role: 'admin', passwordChanged: true },
      },
      {
        ...BASE,
        auditId: 'f',
        targetType: 'facility-access',
        before: { facilityId: 'HOUSE-01', userIds: ['u1', 'u2'] },
        after: { facilityId: 'HOUSE-01', userIds: ['u2', 'u1'] },
      },
      {
        ...BASE,
        auditId: 'f2',
        targetType: 'facility-access',
        before: { facilityId: 'HOUSE-01', userIds: ['u1', 'u2'] },
        after: { facilityId: 'HOUSE-01', userIds: ['u1'] },
      },
    ]);

    expect(cellsOf(at(rows, 0)).after.querySelector('.audit-changes')?.textContent).toBe(
      '変更: ロール　追加: パスワードの変更',
    );
    expect(cellsOf(at(rows, 1)).after.querySelector('.audit-changes')?.textContent).toBe(
      '変更された項目はありません',
    );
    expect(cellsOf(at(rows, 2)).after.querySelector('.audit-changes')?.textContent).toBe(
      '変更: 閲覧できるユーザー',
    );
  });

  it('取り込み設定: 取り込み元ごと（有効・無効）に印。接続の項目にも印を付ける', async () => {
    const sources = [
      { sourceId: 'robot', kind: 'ROBOT', profileId: 'p1', isEnabled: true },
      { sourceId: 'environment-sensor', kind: 'SENSOR', profileId: 'p2', isEnabled: true },
    ];
    const rows = await renderRows([
      {
        ...BASE,
        auditId: 's',
        targetType: 'ingestion-settings',
        before: sources,
        after: [sources[0], { ...sources[1], isEnabled: false }],
      },
      {
        ...BASE,
        auditId: 'c',
        targetType: 'ingestion-settings',
        before: { protocol: 'HTTPS', host: 'files.example.invalid', authMethod: 'NONE' },
        after: {
          protocol: 'HTTPS',
          host: 'files.example.invalid',
          authMethod: 'BASIC',
          port: 8443,
        },
      },
    ]);

    expect(cellsOf(at(rows, 0)).after.querySelector('.audit-changes')?.textContent).toBe(
      '変更: 環境センサーデータ',
    );
    expect(marksIn(cellsOf(at(rows, 0)).after)).toEqual(['変更']);
    expect(cellsOf(at(rows, 1)).after.querySelector('.audit-changes')?.textContent).toBe(
      '変更: 認証方式　追加: ポート番号',
    );
  });
});

describe('判断基準: 指標ごとの閾値を比べる。版・更新日時・更新者は、印の対象にしない', () => {
  const defaults = getDefaultCriteria('harvestAccuracy');
  const [first, ...rest] = defaults.criteria;

  it('閾値が変わった指標だけに印。要約は指標名（画面の呼び方）。版・既定値・更新の情報が変わっても、印は付かない', async () => {
    if (first === undefined) {
      throw new Error('既定の判断基準がありません');
    }
    const changed =
      first.kind === 'LOWER'
        ? {
            ...first,
            thresholds: { ...first.thresholds, cautionBelow: first.thresholds.cautionBelow + 1 },
          }
        : first;
    const { before, after } = cellsOf(
      at(
        await renderRows([
          {
            ...BASE,
            targetType: 'criteria',
            targetId: 'harvestAccuracy',
            before: defaults,
            after: {
              ...defaults,
              criteria: [changed, ...rest],
              version: 'CUSTOM-1',
              isDefault: false,
              updatedAt: '2026-11-25T02:00:00.000Z',
              updatedBy: 'worker-1',
            },
          },
        ]),
        0,
      ),
    );

    expect(first.kind).toBe('LOWER');
    expect(after.querySelector('.audit-changes')?.textContent).toBe('変更: 可販果率');
    expect(marksIn(before)).toEqual(['変更']);
    expect(marksIn(after)).toEqual(['変更']);
    // 版の項目は、印はなくても、表示は残る
    expect(after.textContent).toContain('"version": "CUSTOM-1"');
    expect(within(after).getAllByText('"version": "CUSTOM-1"')).toHaveLength(1);
  });
});

describe('印の見た目（CSS）: 文字つきのタグ + 太字 + 枠線。色だけに頼らず、状態の色と混ぜない', () => {
  const css = readFileSync(
    resolve(import.meta.dirname, '../../../src/frontend/styles/management.css'),
    'utf8',
  );
  const rule = (selector: string): string => {
    const match = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    if (match?.[1] === undefined) {
      throw new Error(`${selector} の規則がありません`);
    }
    return match[1];
  };

  it('タグは、太字・枠線を持ち、文字・面・枠は、中立のトークン（状態の色は使わない）', () => {
    const mark = rule('.diff-mark');

    expect(mark).toMatch(/font-weight:\s*700/);
    expect(mark).toMatch(/border:\s*1px solid var\(--color-border-control\)/);
    expect(mark).toMatch(/background:\s*var\(--color-surface-muted\)/);
    expect(mark).toMatch(/color:\s*var\(--color-text\)/);
    expect(mark).not.toContain('--status-');
  });

  it('「なし」は、枠を破線にする（形でも区別する）', () => {
    expect(rule('.diff-mark-removed')).toMatch(/border-style:\s*dashed/);
  });
});

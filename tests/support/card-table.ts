/**
 * 狭い幅（900px 以下）で、1 行を 1 枚のカードにする表（class="card-table"）の検査（#151）。
 * カードでは、見出しの行を隠し、各セルの data-label を、項目名として表示する。
 * 各セルの data-label が、同じ列の見出しの文字と一致していること（項目名の取り違え・抜けがないこと）を確かめる。
 */

import { expect } from 'vitest';

/** 画面にある、カードにする表（1 つだけ）。 */
export function cardTable(): HTMLTableElement {
  const tables = document.querySelectorAll<HTMLTableElement>('table.card-table');
  const [table] = tables;
  if (table === undefined || tables.length !== 1) {
    throw new Error(`カードにする表が 1 つではありません（${String(tables.length)} 個）`);
  }
  return table;
}

/** 本文の各行のセル（td）の data-label が、同じ列の見出し（th）の文字と一致する。 */
export function expectCardLabels(table: HTMLTableElement = cardTable()): void {
  const headers = Array.from(table.querySelectorAll('thead th')).map((cell) =>
    cell.textContent.trim(),
  );
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  expect(rows.length, '本文の行').toBeGreaterThan(0);
  for (const row of rows) {
    const cells = Array.from(row.children);
    expect(cells.length, '行のセルの数').toBeLessThanOrEqual(headers.length);
    cells.forEach((cell, index) => {
      // 行の見出し（th scope="row"）は、カードの題名で、項目名を持たない
      if (cell.tagName === 'TD') {
        expect(cell.getAttribute('data-label'), `${String(index + 1)} 列目の項目名`).toBe(
          headers[index],
        );
      }
    });
  }
}

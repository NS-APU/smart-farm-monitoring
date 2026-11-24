/**
 * 変更履歴（SC-08）の、変更点の印のための差分（Issue #190。SC-08-5）。変更前後の値を、項目単位に分け、項目ごとに
 * 「変更」「追加」「なくなった（なし）」を求める純粋な関数。API・データは変えない（変更前後の値は、すでに両方返る）。
 *
 * 値の比べ方の規則:
 * - `undefined`（項目がない）と、`null`・空でない値は、違うものとして扱う。値が `undefined` の項目は、ないものとして扱う
 * - 数値と文字列は、違うものとして扱う（`5` と `'5'`）
 * - オブジェクトは、深く比べる（キーの順序は無関係）
 * - 配列は、要素が文字列・数値などだけなら、順序を無視して比べる（閲覧のユーザーの一覧など、集合として意味を持つため）。
 *   オブジェクトの要素を含む配列は、順序どおりに比べる（要素に識別子があるものは、先に、識別子ごとの項目に分ける）
 * - UTC の日時（ISO 8601。末尾 Z）の文字列どうしは、時刻として比べる（小数秒の有無などの表記ゆれを、違いとしない）
 */

/** 項目の印。変更前の側は `changed` だけ。 */
export type DiffMark = 'changed' | 'added' | 'removed';

/** 比べる単位の項目。 */
export interface AuditField {
  /** 変更前後で、同じ項目を結びつける識別子。 */
  readonly key: string;
  /** 画面の呼び方（用語集「画面での呼び方」）。直せないキーは、そのキー名。 */
  readonly label: string;
  readonly value: unknown;
  /** 画面に示す文字（値の整形後）。 */
  readonly text: string;
  /** 印の対象にしない項目（版・更新日時・更新者など）。表示は残す。 */
  readonly ignored?: boolean;
}

export interface FieldDiff {
  /** この側の項目ごとの印（キー → 印）。 */
  readonly marks: ReadonlyMap<string, DiffMark>;
  /** 変更前にあって、変更後にない項目（変更後の側で、「なし」の印を付けて示す）。変更前の側は、空。 */
  readonly vanished: readonly AuditField[];
  readonly changedLabels: readonly string[];
  readonly addedLabels: readonly string[];
  readonly vanishedLabels: readonly string[];
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isPrimitive(value: unknown): boolean {
  return typeof value !== 'object' || value === null;
}

function definedEntries(record: Readonly<Record<string, unknown>>): [string, unknown][] {
  return Object.entries(record).filter(([, value]) => value !== undefined);
}

/** 変更前後の値が、同じか（規則は、ファイルの先頭）。 */
export function isSameValue(left: unknown, right: unknown): boolean {
  if (
    typeof left === 'string' &&
    typeof right === 'string' &&
    ISO_DATE_TIME.test(left) &&
    ISO_DATE_TIME.test(right)
  ) {
    return Date.parse(left) === Date.parse(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    if (left.every(isPrimitive) && right.every(isPrimitive)) {
      const keysOf = (values: readonly unknown[]): string[] =>
        values.map((value) => JSON.stringify(value)).sort();
      return keysOf(left).join('\n') === keysOf(right).join('\n');
    }
    return left.every((value, index) => isSameValue(value, right[index]));
  }
  const leftRecord = recordOf(left);
  const rightRecord = recordOf(right);
  if (leftRecord !== undefined && rightRecord !== undefined) {
    const leftEntries = definedEntries(leftRecord);
    return (
      leftEntries.length === definedEntries(rightRecord).length &&
      leftEntries.every(([key, value]) => isSameValue(value, rightRecord[key]))
    );
  }
  return left === right;
}

/** 配列の要素を、項目として分けるときの、識別子のキー（指標・取り込み元）。 */
const IDENTITY_KEYS = ['indicator', 'sourceId'] as const;

function identityOf(element: unknown): string | undefined {
  const record = recordOf(element);
  for (const key of IDENTITY_KEYS) {
    const value = record?.[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** 要素のすべてに、重ならない識別子があれば、識別子ごとの要素を返す。なければ undefined。 */
function identifiedElements(
  value: unknown,
): readonly { readonly id: string; readonly element: unknown }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const elements: { id: string; element: unknown }[] = [];
  for (const element of value) {
    const id = identityOf(element);
    if (id === undefined || elements.some((candidate) => candidate.id === id)) {
      return undefined;
    }
    elements.push({ id, element });
  }
  return elements;
}

export interface FieldOptions {
  /** 印の対象にしないキー（トップレベル。分けた要素は、親のキーで判定する）。 */
  readonly ignoredKeys?: readonly string[];
  /** キーの画面の呼び方。 */
  readonly labelOf: (key: string) => string;
  /** 配列の要素（識別子つき）の画面の呼び方。親のキー（トップレベルの配列は空）と識別子から。 */
  readonly elementLabelOf: (parentKey: string, id: string) => string;
}

/**
 * 変更前後の値（記録）を、項目に分ける。トップレベルのキーごと。識別子を持つオブジェクトの配列
 * （判断基準の指標・取り込み元）は、要素ごとの項目にする。記録でも、識別子つきの配列でもなければ、undefined
 * （呼び出し側は、そのまま JSON を示す）。
 */
export function auditFieldsOf(value: unknown, options: FieldOptions): AuditField[] | undefined {
  const ignoredKeys = options.ignoredKeys ?? [];
  const expand = (parentKey: string, elements: ReturnType<typeof identifiedElements>) =>
    (elements ?? []).map(({ id, element }) => ({
      key: parentKey === '' ? id : `${parentKey}[${id}]`,
      label: options.elementLabelOf(parentKey, id),
      value: element,
      text: JSON.stringify(element, null, 2),
      ignored: ignoredKeys.includes(parentKey),
    }));
  const topLevelElements = identifiedElements(value);
  if (topLevelElements !== undefined) {
    return expand('', topLevelElements);
  }
  const record = recordOf(value);
  if (record === undefined) {
    return undefined;
  }
  return definedEntries(record).flatMap(([key, fieldValue]): AuditField[] => {
    const elements = identifiedElements(fieldValue);
    if (elements !== undefined) {
      return expand(key, elements);
    }
    return [
      {
        key,
        label: options.labelOf(key),
        value: fieldValue,
        text: `${JSON.stringify(key)}: ${JSON.stringify(fieldValue, null, 2)}`,
        ignored: ignoredKeys.includes(key),
      },
    ];
  });
}

/**
 * ある側の項目に付ける印を求める。`side` が `after`（変更後）のときは、変更前にない項目を「追加」、値が違う項目を「変更」、
 * 変更前にあって変更後にない項目を `vanished`（「なし」）にする。`before` のときは、値が違う項目だけを「変更」にする。
 * 印の対象にしない項目（`ignored`）は、印を付けない。
 */
export function diffFields(
  side: 'before' | 'after',
  own: readonly AuditField[],
  other: readonly AuditField[],
): FieldDiff {
  const marks = new Map<string, DiffMark>();
  const changedLabels: string[] = [];
  const addedLabels: string[] = [];
  for (const field of own) {
    if (field.ignored === true) {
      continue;
    }
    const counterpart = other.find((candidate) => candidate.key === field.key);
    if (counterpart === undefined) {
      if (side === 'after') {
        marks.set(field.key, 'added');
        addedLabels.push(field.label);
      }
    } else if (!isSameValue(field.value, counterpart.value)) {
      marks.set(field.key, 'changed');
      changedLabels.push(field.label);
    }
  }
  const vanished =
    side === 'after'
      ? other.filter(
          (candidate) =>
            candidate.ignored !== true && !own.some((field) => field.key === candidate.key),
        )
      : [];
  return {
    marks,
    vanished,
    changedLabels,
    addedLabels,
    vanishedLabels: vanished.map((field) => field.label),
  };
}

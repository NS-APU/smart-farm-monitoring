/**
 * 操作の計測と記録。各操作について、次の2つの時間を測り、records.jsonl に1行ずつ追記する
 * （globalTeardown が、結果ログ test-result/stresstest.result.log にまとめる。report-log.ts）。
 *
 *  1. 応答時間: 操作（クリック・送信・遷移）の直前から、画面が応答する（結果・次の画面の主要な内容が描画される）まで
 *  2. 次の操作が可能になるまでの時間: 操作の直前から、次の操作ができる状態になるまで
 *     （「読み込み中」の表示が消え、保存中のボタンが有効に戻り、画面に関わる API の通信がすべて終わり、1回描画される）
 *
 * 許容時間（limits.ts）を超えたら、ソフトな検証で失敗にする（以降の操作も続けて計測し、全操作を記録する）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, type Page, type Request } from '@playwright/test';
import { effectiveLimit, type LimitKey } from './limits.ts';

export const STRESS_OUTPUT_DIR = 'test-result/stress';
export const RECORDS_PATH = `${STRESS_OUTPUT_DIR}/records.jsonl`;

export type Scenario = '単独利用' | '同時接続' | '大量取り込み';

export interface ActionSpec {
  /** ユースケース（例: `UC-01`）。 */
  readonly uc: string;
  /** 操作名（利用者の操作を、日本語で）。 */
  readonly action: string;
  /** 画面（例: `ダッシュボード（SC-02）`）。 */
  readonly screen: string;
  readonly limit: LimitKey;
  readonly scenario?: Scenario;
  /** 同時接続の利用者（ユーザーID）。 */
  readonly user?: string;
  /** 画面が応答するまでの待ちの上限（ミリ秒）。許容時間より十分に長くし、遅い操作も記録する。 */
  readonly timeoutMs?: number;
}

export interface ActionRecord {
  readonly scenario: Scenario;
  readonly uc: string;
  readonly action: string;
  readonly screen: string;
  readonly user: string;
  readonly limitKey: LimitKey;
  readonly limitSeconds: number;
  /** 応答時間（秒）。応答しなかった場合は、待った時間。 */
  readonly responseSeconds: number;
  /** 次の操作が可能になるまで（秒）。 */
  readonly readySeconds: number;
  readonly responded: boolean;
  /** 操作の間に始まった API の通信のうち、最も遅いもの（ミリ秒）と、その API。 */
  readonly apiMaxMs: number | null;
  readonly apiPath: string;
  readonly verdict: 'OK' | 'NG';
  readonly note: string;
}

/** 操作の中身。 */
export interface ActionSteps {
  /** 操作（クリック・送信・遷移）。文字列を返すと、備考として、結果ログに載せる。 */
  readonly act: () => Promise<unknown>;
  /** 画面が応答した（結果・次の画面の主要な内容が描画された）ことを待つ。 */
  readonly respond: () => Promise<unknown>;
  /** 追加の「次の操作が可能」の条件（既定の条件に加える）。 */
  readonly ready?: () => Promise<unknown>;
  /** 備考（結果ログに載せる）。 */
  readonly note?: string;
}

interface ApiCall {
  readonly path: string;
  readonly start: number;
  end: number | undefined;
  /** HTTP のエラー（400 以上）の応答の、状態とエラーコード。 */
  failure?: string;
}

/** ページごとの、API の通信の追跡。 */
interface ApiTracker {
  readonly calls: ApiCall[];
  readonly open: Map<Request, ApiCall>;
}

const TRACKERS = new WeakMap<Page, ApiTracker>();

const API_PATH_PREFIX = '/api/v1/';
const DEFAULT_RESPOND_TIMEOUT_MS = 60_000;

function now(): number {
  return performance.now();
}

/** ページの API の通信（/api/v1/）を追跡する。1ページにつき1回、操作の前に呼ぶ（measure が自動で呼ぶ）。 */
export function trackApi(page: Page): ApiTracker {
  const existing = TRACKERS.get(page);
  if (existing !== undefined) {
    return existing;
  }
  const tracker: ApiTracker = { calls: [], open: new Map() };
  const finish = (request: Request): void => {
    const call = tracker.open.get(request);
    if (call !== undefined) {
      call.end = now();
      tracker.open.delete(request);
    }
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(API_PATH_PREFIX)) {
      return;
    }
    const call: ApiCall = {
      path: `${request.method()} ${url.pathname.slice(API_PATH_PREFIX.length - 1)}`,
      start: now(),
      end: undefined,
    };
    tracker.calls.push(call);
    tracker.open.set(request, call);
  });
  page.on('response', (response) => {
    const call = tracker.open.get(response.request());
    if (call === undefined || response.status() < 400) {
      return;
    }
    const status = String(response.status());
    call.failure = status;
    // エラーコード（共通のエラー形式の error.code）を、備考に載せる。本文が読めなければ、状態だけ
    void response
      .json()
      .then((body: { error?: { code?: string } }) => {
        call.failure = `${status} ${body.error?.code ?? ''}`.trim();
      })
      .catch(() => undefined);
  });
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
  TRACKERS.set(page, tracker);
  return tracker;
}

/** 通信中の API の数。 */
function openCount(tracker: ApiTracker): number {
  return tracker.open.size;
}

/**
 * 次の操作ができる状態まで待つ: 「読み込み中」の表示がない、保存中（送信ボタンが無効）の表示がない、
 * API の通信がすべて終わっている、描画が1回済んでいる。
 */
export async function waitUntilIdle(page: Page, timeoutMs: number): Promise<void> {
  const tracker = trackApi(page);
  const deadline = now() + timeoutMs;
  for (;;) {
    const busy = await page.evaluate(
      () =>
        document.querySelector('main [role="status"].state-view') !== null ||
        document.querySelector('main button[type="submit"]:disabled') !== null ||
        document.querySelector('[aria-busy="true"]') !== null,
    );
    if (!busy && openCount(tracker) === 0) {
      // 通信の終了のあとに、画面の描画が1回済むのを待つ
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          }),
      );
      if (openCount(tracker) === 0) {
        return;
      }
    }
    if (now() > deadline) {
      throw new Error('次の操作ができる状態になりませんでした（読み込み中・通信中のまま）');
    }
    await page.waitForTimeout(10);
  }
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function errorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // 色の制御文字（ANSI のエスケープ）を除く
  return message.replace(ANSI_COLOR, '').split('\n')[0]?.slice(0, 160) ?? '';
}

/**
 * 操作を実行し、応答時間・次の操作が可能になるまでの時間を測って記録する。
 * 許容時間を超えた場合は、ソフトな検証で失敗にする（続けて、次の操作を計測する）。
 */
export async function measure(
  page: Page,
  spec: ActionSpec,
  steps: ActionSteps,
): Promise<ActionRecord> {
  const tracker = trackApi(page);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_RESPOND_TIMEOUT_MS;
  const limit = effectiveLimit(spec.limit);
  const callsBefore = tracker.calls.length;
  const notes: string[] = steps.note === undefined ? [] : [steps.note];

  const started = now();
  let responseMs: number;
  let readyMs: number;
  let responded = true;
  try {
    const acted = await steps.act();
    if (typeof acted === 'string') {
      notes.push(acted);
    }
    await steps.respond();
    responseMs = now() - started;
  } catch (error) {
    responded = false;
    responseMs = now() - started;
    notes.push(`応答なし: ${errorNote(error)}`);
  }
  try {
    await waitUntilIdle(page, timeoutMs);
    if (steps.ready !== undefined && responded) {
      await steps.ready();
    }
    readyMs = now() - started;
  } catch (error) {
    readyMs = now() - started;
    notes.push(`次の操作が可能にならない: ${errorNote(error)}`);
  }

  // HTTP のエラーの応答（400 以上）があれば、備考に載せる（原因の調査用）
  for (const call of tracker.calls.slice(callsBefore)) {
    if (call.failure !== undefined) {
      notes.push(`HTTP エラー: ${call.path} → ${call.failure}`);
    }
  }
  const slowest = tracker.calls
    .slice(callsBefore)
    .map((call) => ({ path: call.path, ms: (call.end ?? now()) - call.start }))
    .sort((left, right) => right.ms - left.ms)[0];

  const responseSeconds = responseMs / 1000;
  const readySeconds = readyMs / 1000;
  const verdict =
    responded && responseSeconds <= limit.seconds && readySeconds <= limit.seconds ? 'OK' : 'NG';
  const record: ActionRecord = {
    scenario: spec.scenario ?? '単独利用',
    uc: spec.uc,
    action: spec.action,
    screen: spec.screen,
    user: spec.user ?? '',
    limitKey: spec.limit,
    limitSeconds: limit.seconds,
    responseSeconds,
    readySeconds,
    responded,
    apiMaxMs: slowest === undefined ? null : Math.round(slowest.ms),
    apiPath: slowest?.path ?? '',
    verdict,
    note: notes.join(' / '),
  };
  appendRecord(record);

  const label = `${spec.uc} ${spec.action}${spec.user === undefined ? '' : `（${spec.user}）`}`;
  expect.soft(responded, `${label}: 画面が応答した`).toBe(true);
  expect
    .soft(responseSeconds, `${label}: 応答時間（秒）が許容 ${String(limit.seconds)} 秒以内`)
    .toBeLessThanOrEqual(limit.seconds);
  expect
    .soft(
      readySeconds,
      `${label}: 次の操作が可能になるまで（秒）が許容 ${String(limit.seconds)} 秒以内`,
    )
    .toBeLessThanOrEqual(limit.seconds);
  return record;
}

export function appendRecord(record: ActionRecord): void {
  mkdirSync(STRESS_OUTPUT_DIR, { recursive: true });
  appendFileSync(RECORDS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * 約10秒ごとの自動更新（NFR-3.3）を計測する。次の更新の通信（パスに `pathPart` を含む GET）が始まった時点から、
 * 応答を受け取るまでを応答時間、画面が次の操作ができる状態になるまでを次の操作が可能になるまでの時間とする。
 */
export async function measureRefresh(
  page: Page,
  spec: ActionSpec,
  pathPart: string,
): Promise<ActionRecord> {
  trackApi(page);
  const limit = effectiveLimit(spec.limit);
  const notes: string[] = [];
  let responseMs = 0;
  let readyMs = 0;
  let responded = true;
  let apiMs: number | null = null;
  let apiPath = '';
  const request = await page.waitForEvent('request', {
    predicate: (candidate) =>
      candidate.method() === 'GET' && new URL(candidate.url()).pathname.includes(pathPart),
    timeout: 30_000,
  });
  const started = now();
  try {
    const response = await request.response();
    responseMs = now() - started;
    apiMs = Math.round(responseMs);
    apiPath = `GET ${new URL(request.url()).pathname.slice(API_PATH_PREFIX.length - 1)}`;
    notes.push(`状態 ${String(response?.status() ?? 0)}`);
  } catch (error) {
    responded = false;
    responseMs = now() - started;
    notes.push(`応答なし: ${errorNote(error)}`);
  }
  try {
    await waitUntilIdle(page, spec.timeoutMs ?? DEFAULT_RESPOND_TIMEOUT_MS);
    readyMs = now() - started;
  } catch (error) {
    readyMs = now() - started;
    notes.push(`次の操作が可能にならない: ${errorNote(error)}`);
  }
  const responseSeconds = responseMs / 1000;
  const readySeconds = readyMs / 1000;
  const record: ActionRecord = {
    scenario: spec.scenario ?? '単独利用',
    uc: spec.uc,
    action: spec.action,
    screen: spec.screen,
    user: spec.user ?? '',
    limitKey: spec.limit,
    limitSeconds: limit.seconds,
    responseSeconds,
    readySeconds,
    responded,
    apiMaxMs: apiMs,
    apiPath,
    verdict:
      responded && responseSeconds <= limit.seconds && readySeconds <= limit.seconds ? 'OK' : 'NG',
    note: notes.join(' / '),
  };
  appendRecord(record);
  const label = `${spec.uc} ${spec.action}`;
  expect.soft(responded, `${label}: 更新の応答があった`).toBe(true);
  expect
    .soft(responseSeconds, `${label}: 応答時間（秒）が許容以内`)
    .toBeLessThanOrEqual(limit.seconds);
  expect
    .soft(readySeconds, `${label}: 次の操作が可能になるまで（秒）が許容以内`)
    .toBeLessThanOrEqual(limit.seconds);
  return record;
}

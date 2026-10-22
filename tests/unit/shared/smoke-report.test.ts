/** サーバーレス環境のスモークテストの結果ログの組み立て（tests/smoke/support/smoke-report.ts。Issue #79）。 */

import { describe, expect, it } from 'vitest';
import type { ActionRecord } from '../../stress/support/recorder.ts';
import {
  buildSmokeReport,
  jobDurationLine,
  type SmokeEnvironmentInfo,
} from '../../smoke/support/smoke-report.ts';

const ENVIRONMENT: SmokeEnvironmentInfo = {
  startedAt: '2026-10-21T00:00:00.000Z',
  os: 'Dummy OS 1',
  node: 'v0.0.0',
  browser: 'Chromium 0',
  playwright: '1.0',
};

function record(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    scenario: '単独利用',
    uc: 'NFR-3.4',
    action: 'ログインして、ダッシュボードを表示する',
    screen: 'ダッシュボード（SC-02）',
    user: '',
    limitKey: 'dashboardInitial',
    limitSeconds: 3,
    responseSeconds: 1.5,
    readySeconds: 2,
    responded: true,
    apiMaxMs: 800,
    apiPath: 'GET /dashboard',
    verdict: 'OK',
    note: '1/5 回目',
    ...overrides,
  };
}

describe('取り込みの実行時間の行', () => {
  it('件数・最大・p50・p95 と、タイムアウトに対する最大の割合を示す', () => {
    const line = jobDurationLine({
      sourceId: 'robot',
      seconds: [1, 2, 3, 4, 30],
      timeoutSeconds: 300,
    });

    expect(line).toContain('robot');
    expect(line).toContain('件数 5');
    expect(line).toContain('最大 30.000 秒');
    expect(line).toContain('p50 3.000 秒');
    expect(line).toContain('上限 300 秒に対する最大の割合 10.0 %');
  });

  it('実行の記録がなければ、その旨を示す', () => {
    expect(jobDurationLine({ sourceId: 'robot', seconds: [], timeoutSeconds: 300 })).toContain(
      '実行の記録なし',
    );
  });
});

describe('結果ログ', () => {
  it('実行日時・端末の環境・許容時間・操作ごとの結果・集計・判定を含む', () => {
    const text = buildSmokeReport({
      records: [record(), record({ responseSeconds: 4, verdict: 'NG', note: '遅い' })],
      environment: ENVIRONMENT,
      jobDurations: [{ sourceId: 'robot', seconds: [2], timeoutSeconds: 300 }],
      finishedAt: '2026-10-21T00:01:00.000Z',
    });

    expect(text).toContain(
      '# 実行日時: 2026-10-21 09:00:00 JST 〜 2026-10-21 09:01:00 JST（60 秒）',
    );
    expect(text).toContain('OS Dummy OS 1 / Node v0.0.0 / ブラウザ Chromium 0');
    expect(text).toContain('dashboardInitial\t3 秒');
    expect(text).toContain('1\tNFR-3.4\tログインして、ダッシュボードを表示する');
    expect(text).toContain('全体\t件数 2\tOK 1\tNG 1');
    expect(text).toContain('# 定期の取り込み（JB-01）の実行時間');
    expect(text).toContain('# 判定: NG 1 件（全 2 操作）');
    expect(text).toContain('#   NG\tNFR-3.4');
  });

  it('すべて許容時間内なら、NG 0 件と判定する。取り込みの実行時間がなければ、その節を出さない', () => {
    const text = buildSmokeReport({
      records: [record()],
      environment: ENVIRONMENT,
      jobDurations: [],
      finishedAt: '2026-10-21T00:00:10.000Z',
    });

    expect(text).toContain('# 判定: 全 1 操作が許容時間内（NG 0 件）');
    expect(text).not.toContain('定期の取り込み（JB-01）');
  });

  it('環境の URL・認証情報に関わる項目を、載せない', () => {
    const text = buildSmokeReport({
      records: [record()],
      environment: ENVIRONMENT,
      jobDurations: [],
      finishedAt: '2026-10-21T00:00:10.000Z',
    });

    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/SMOKE_(BASE_URL|USER_ID|PASSWORD)/);
  });
});

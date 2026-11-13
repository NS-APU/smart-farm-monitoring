/**
 * 農業情報基盤の連携の context（JSON-LD。独自の型・属性の定義。ADR-0024。Issue #177）の確認。
 * context は、このリポジトリに置き、GitHub の raw の URL を、設定の context URL にする（機密情報を含まない）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEDERATION_CONTEXT_URL } from '../../../src/backend/application/federation/federation-connection-store.ts';

const CONTEXT_PATH = 'docs/10_design/data/ngsi-ld-context.jsonld';
const SMART_DATA_MODELS_ENVIRONMENT_CONTEXT =
  'https://raw.githubusercontent.com/smart-data-models/dataModel.Environment/master/context.jsonld';

function readContext(): { '@context': unknown[] } {
  return JSON.parse(readFileSync(CONTEXT_PATH, 'utf8')) as { '@context': unknown[] };
}

describe('農業情報基盤の連携の context', () => {
  it('JSON-LD として読め、スマートデータモデル（Environment）の context を取り込み、独自の用語は、@vocab で定義する', () => {
    const { '@context': context } = readContext();

    expect(Array.isArray(context)).toBe(true);
    expect(context[0]).toBe(SMART_DATA_MODELS_ENVIRONMENT_CONTEXT);
    expect(context[1]).toMatchObject({ '@vocab': expect.stringMatching(/^https:\/\//) as unknown });
  });

  it('設定の context URL の既定は、この context を指す（リポジトリの docs の、同じパス）', () => {
    expect(DEFAULT_FEDERATION_CONTEXT_URL).toBe(
      `https://raw.githubusercontent.com/NS-APU/smart-farm-monitoring/develop/${CONTEXT_PATH}`,
    );
  });

  it('接続先・認証情報・ホスト名（基盤のホスト）を、含まない', () => {
    const text = readFileSync(CONTEXT_PATH, 'utf8');

    expect(text).not.toMatch(/systemdesign|ak-agri|platform\./i);
  });
});

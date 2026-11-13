/**
 * 連携先の設定（SC-11。UC-15。ADR-0024。Issue #177 の PR 3）の画面テスト。
 * 接続先は書き込み専用（値は表示しない。設定済みかと更新日時だけ）。テナント名・context の URL・有効／無効、保存、接続の確認、
 * 入力の検証、モックの環境の案内、参照だけの権限。
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../../support/frontend.ts';
import {
  callsOf,
  errorBody,
  loginWith,
  renderApp,
  type Routes,
} from '../../support/management-frontend.ts';

const SETTINGS = {
  tenant: 'smart_farm_monitoring',
  contextUrl: 'https://example.test/context.jsonld',
  enabled: false,
};

function settingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'ngsi-ld',
    settings: SETTINGS,
    endpoint: { configured: false },
    ...overrides,
  };
}

function routes(federationSettings: unknown, extra: Routes = {}): Routes {
  return {
    'GET /ingestion/settings': () => jsonResponse({ sources: [] }),
    'GET /ingestion/logs': () => jsonResponse({ items: [], nextCursor: null }),
    'GET /federation/logs': () =>
      jsonResponse({
        items: [],
        nextCursor: null,
        queue: { PENDING: 0, SENT: 0, FAILED: 0, HELD: 0, EXPIRED: 0 },
      }),
    'GET /federation/settings': () => jsonResponse(federationSettings),
    ...extra,
  };
}

beforeEach(() => {
  window.history.pushState(null, '', '/');
});

async function panel(): Promise<HTMLElement> {
  // 設定を読み込んで、フォームが出るまで待つ
  await screen.findByTestId('federation-endpoint-status');
  return screen.getByTestId('federation-settings');
}

describe('連携先の設定の表示', () => {
  it('テナント名・context の URL・有効／無効と、接続先の状態（未設定）を示す。接続先の入力欄は、空', async () => {
    renderApp('/settings/ingestion', routes(settingsResponse()));
    const scope = await panel();

    expect(within(scope).getByLabelText<HTMLInputElement>('テナント名').value).toBe(
      'smart_farm_monitoring',
    );
    expect(within(scope).getByLabelText<HTMLInputElement>('context の URL').value).toBe(
      'https://example.test/context.jsonld',
    );
    expect(within(scope).getByLabelText<HTMLInputElement>('連携を有効にする').checked).toBe(false);
    expect(within(scope).getByTestId('federation-endpoint-status').textContent).toContain('未設定');
    expect(
      within(scope).getByLabelText<HTMLInputElement>('接続先の URL（書き込み専用）').value,
    ).toBe('');
  });

  it('接続先が設定済みなら、設定済みと更新日時を示す。接続先の値は、どこにも示さない', async () => {
    renderApp(
      '/settings/ingestion',
      routes(
        settingsResponse({
          settings: { ...SETTINGS, enabled: true },
          endpoint: { configured: true, updatedAt: '2026-11-13T03:00:00.000Z' },
        }),
      ),
    );
    const scope = await panel();

    const status = within(scope).getByTestId('federation-endpoint-status').textContent;
    expect(status).toContain('設定済み');
    expect(status).toContain('2026');
    expect(within(scope).getByLabelText<HTMLInputElement>('連携を有効にする').checked).toBe(true);
    expect(scope.textContent).not.toContain('platform.example.test');
  });

  it('モックの環境では、設定が使われない旨を示す', async () => {
    renderApp('/settings/ingestion', routes(settingsResponse({ mode: 'mock' })));
    const scope = await panel();

    expect(within(scope).getByTestId('federation-mock-note').textContent).toContain('モック');
  });
});

describe('連携先の設定の保存', () => {
  it('接続先・テナント名・context の URL・有効を送って保存する。保存後は、接続先の入力欄を空にし、設定済みを示す', async () => {
    let saved = false;
    const { calls } = renderApp(
      '/settings/ingestion',
      routes(settingsResponse(), {
        'GET /federation/settings': () =>
          jsonResponse(
            saved
              ? settingsResponse({
                  settings: { ...SETTINGS, tenant: 'my_tenant', enabled: true },
                  endpoint: { configured: true, updatedAt: '2026-11-13T03:00:00.000Z' },
                })
              : settingsResponse(),
          ),
        'PUT /federation/settings': () => {
          saved = true;
          return jsonResponse(
            settingsResponse({
              settings: { ...SETTINGS, tenant: 'my_tenant', enabled: true },
              endpoint: { configured: true, updatedAt: '2026-11-13T03:00:00.000Z' },
            }),
          );
        },
      }),
    );
    const scope = await panel();

    fireEvent.change(within(scope).getByLabelText('接続先の URL（書き込み専用）'), {
      target: { value: 'https://platform.example.test/api/orion/ngsi-ld/v1' },
    });
    fireEvent.change(within(scope).getByLabelText('テナント名'), {
      target: { value: 'my_tenant' },
    });
    fireEvent.click(within(scope).getByLabelText('連携を有効にする'));
    fireEvent.click(within(scope).getByRole('button', { name: '連携先の設定を保存' }));

    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/federation/settings')).toHaveLength(1);
    });
    expect(callsOf(calls, 'PUT', '/federation/settings')[0]?.body).toEqual({
      settings: {
        tenant: 'my_tenant',
        contextUrl: 'https://example.test/context.jsonld',
        enabled: true,
      },
      endpoint: 'https://platform.example.test/api/orion/ngsi-ld/v1',
    });
    expect((await within(scope).findByTestId('federation-settings-result')).textContent).toContain(
      '保存しました',
    );
    expect(
      within(scope).getByLabelText<HTMLInputElement>('接続先の URL（書き込み専用）').value,
    ).toBe('');
    expect(scope.textContent).not.toContain('platform.example.test');
  });

  it('接続先の入力が空なら、接続先を送らない（保存済みの接続先を保つ）', async () => {
    const { calls } = renderApp(
      '/settings/ingestion',
      routes(settingsResponse({ endpoint: { configured: true } }), {
        'PUT /federation/settings': () => jsonResponse(settingsResponse()),
      }),
    );
    const scope = await panel();

    fireEvent.change(within(scope).getByLabelText('テナント名'), {
      target: { value: 'other_tenant' },
    });
    fireEvent.click(within(scope).getByRole('button', { name: '連携先の設定を保存' }));

    await waitFor(() => {
      expect(callsOf(calls, 'PUT', '/federation/settings')).toHaveLength(1);
    });
    expect(callsOf(calls, 'PUT', '/federation/settings')[0]?.body).toEqual({
      settings: { ...SETTINGS, tenant: 'other_tenant' },
    });
  });

  it.each([
    [
      '接続先が URL でない',
      '接続先の URL（書き込み専用）',
      'not-a-url',
      '接続先は、http または https',
    ],
    ['テナント名が不正', 'テナント名', 'Bad Tenant', 'テナント名は'],
    ['context が URL でない', 'context の URL', 'x', 'context の URL は'],
  ])('入力の検証: %s は、項目のエラーを示し、送らない', async (_name, label, value, message) => {
    const { calls } = renderApp('/settings/ingestion', routes(settingsResponse()));
    const scope = await panel();

    fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
    fireEvent.click(within(scope).getByRole('button', { name: '連携先の設定を保存' }));

    expect(await within(scope).findByText(message, { exact: false })).toBeDefined();
    expect(callsOf(calls, 'PUT', '/federation/settings')).toHaveLength(0);
  });

  it('サーバーの項目のエラー（接続先が未設定のまま有効）を、示す', async () => {
    renderApp(
      '/settings/ingestion',
      routes(settingsResponse(), {
        'PUT /federation/settings': () =>
          errorBody(400, 'VALIDATION_ERROR', '入力内容に誤りがあります', [
            { name: 'settings.enabled', message: '接続先を設定してから、有効にしてください' },
          ]),
      }),
    );
    const scope = await panel();

    fireEvent.click(within(scope).getByLabelText('連携を有効にする'));
    fireEvent.click(within(scope).getByRole('button', { name: '連携先の設定を保存' }));

    expect(
      await within(scope).findByText('接続先を設定してから、有効にしてください'),
    ).toBeDefined();
  });
});

describe('接続の確認', () => {
  it('結果（成功・失敗）のメッセージを示す', async () => {
    let ok = true;
    const { calls } = renderApp(
      '/settings/ingestion',
      routes(settingsResponse({ endpoint: { configured: true } }), {
        'POST /federation/test': () =>
          jsonResponse(
            ok
              ? { ok: true, message: '農業情報基盤に接続できました' }
              : { ok: false, message: '農業情報基盤に接続できません' },
          ),
      }),
    );
    const scope = await panel();

    fireEvent.click(within(scope).getByRole('button', { name: '接続を確認' }));
    const success = await within(scope).findByTestId('federation-test-result');
    expect(success.textContent).toContain('農業情報基盤に接続できました');
    expect(success.className).toContain('form-success');

    ok = false;
    fireEvent.click(within(scope).getByRole('button', { name: '接続を確認' }));
    await waitFor(() => {
      expect(within(scope).getByTestId('federation-test-result').textContent).toContain(
        '農業情報基盤に接続できません',
      );
    });
    expect(within(scope).getByTestId('federation-test-result').className).toContain('form-error');
    expect(callsOf(calls, 'POST', '/federation/test')).toHaveLength(2);
  });
});

describe('権限', () => {
  it('参照だけの権限（ingestion:read）では、入力は変更できず、保存・接続の確認の操作も、ない', async () => {
    renderApp('/settings/ingestion', routes(settingsResponse()), {
      login: loginWith(['ingestion:read']),
    });
    const scope = await panel();

    expect(within(scope).getByLabelText<HTMLInputElement>('テナント名').readOnly).toBe(true);
    expect(within(scope).getByLabelText<HTMLInputElement>('連携を有効にする').disabled).toBe(true);
    expect(within(scope).queryByRole('button', { name: '連携先の設定を保存' })).toBeNull();
    expect(within(scope).queryByRole('button', { name: '接続を確認' })).toBeNull();
  });
});

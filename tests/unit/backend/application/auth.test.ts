/** 認可の方針（ロール → 権限）と、認証サービスのテスト（ポートは、モックにする）。 */

import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@smart-farm/shared/constants/permissions';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  DEFAULT_ROLE_CONFIG,
  createAccessPolicy,
} from '../../../../src/backend/application/auth/access-policy.ts';
import { createAuthService } from '../../../../src/backend/application/auth/auth-service.ts';

describe('認可の方針（ロール → 権限）', () => {
  const policy = createAccessPolicy({
    admin: { name: '管理者', permissions: ['user:manage', 'criteria:edit'] },
    viewer: { name: '閲覧者', permissions: [] },
  });

  it('ロールに割り当てた権限だけを持つ', () => {
    expect(policy.permissionsOf('admin')).toEqual(['user:manage', 'criteria:edit']);
    expect(policy.can('admin', 'user:manage')).toBe(true);
    expect(policy.can('admin', 'equipment:manage')).toBe(false);
    expect(policy.can('viewer', 'user:manage')).toBe(false);
    expect(policy.roleIds()).toEqual(['admin', 'viewer']);
  });

  it('未知のロールは、権限を持たない', () => {
    expect(policy.isKnownRole('admin')).toBe(true);
    expect(policy.isKnownRole('unknown')).toBe(false);
    expect(policy.isKnownRole('toString')).toBe(false);
    expect(policy.permissionsOf('unknown')).toEqual([]);
    expect(policy.can('unknown', 'user:manage')).toBe(false);
  });

  it('既定は、1ロール（農作業者）が全権限を持つ', () => {
    const defaults = createAccessPolicy(DEFAULT_ROLE_CONFIG);

    expect(defaults.roleIds()).toEqual(['worker']);
    expect(defaults.permissionsOf('worker')).toEqual(PERMISSIONS);
  });
});

describe('認証サービス', () => {
  const principal = { userId: toUserId('user-1'), userName: 'ユーザー', role: 'viewer' };
  const session = {
    accessToken: 'a',
    refreshToken: 'r',
    accessTokenExpiresAt: new Date('2026-10-09T03:30:00Z'),
    refreshTokenExpiresAt: new Date('2026-10-16T03:00:00Z'),
    principal,
  };
  const auth = {
    login: vi.fn().mockResolvedValue(session),
    refresh: vi.fn().mockResolvedValue(session),
    logout: vi.fn().mockResolvedValue(undefined),
    revokeSessionsOf: vi.fn().mockResolvedValue(undefined),
    verifyAccessToken: vi.fn((token: string) =>
      Promise.resolve(token === 'valid' ? principal : null),
    ),
  };
  const service = createAuthService({
    auth,
    policy: createAccessPolicy({ viewer: { name: '閲覧者', permissions: ['audit:read'] } }),
  });

  it('ログイン・更新の応答に、有効期限（ISO 8601）と、ロールの権限を含める', async () => {
    const login = await service.login('user-1', 'pw', 'client');
    const refreshed = await service.refresh('r');

    expect(login).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: '2026-10-09T03:30:00.000Z',
      refreshTokenExpiresAt: '2026-10-16T03:00:00.000Z',
      user: { userId: 'user-1', userName: 'ユーザー', role: 'viewer', permissions: ['audit:read'] },
    });
    expect(refreshed).toEqual(login);
    expect(auth.login).toHaveBeenCalledWith({ userId: 'user-1', password: 'pw' }, 'client');
  });

  it('有効なトークンから、権限つきの利用者を返す。無効なトークンは null', async () => {
    expect(await service.authenticate('valid')).toMatchObject({
      userId: 'user-1',
      permissions: ['audit:read'],
    });
    expect(await service.authenticate('invalid')).toBeNull();
  });

  it('ログアウトを、認証のポートへ伝える', async () => {
    await service.logout('a');

    expect(auth.logout).toHaveBeenCalledWith('a');
  });
});

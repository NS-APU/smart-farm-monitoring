/**
 * 認証・認可の補助: 認証、権限の確認（接続元の識別は client-address.ts）。
 * 認証・認可は、全ルートに適用し、公開ルートを明示する（route-table.ts）。クライアントの申告だけに頼らない。
 */

import type { Context } from 'hono';
import { AppError } from '@smart-farm/shared/errors';
import type { Permission } from '@smart-farm/shared/constants/permissions';
import type { AuthenticatedUser } from '@smart-farm/shared/schemas/auth';
import type { AuthService } from '../application/auth/auth-service.ts';
import type { AppEnv } from './api-deps.ts';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export function bearerTokenOf(c: Context<AppEnv>): string | undefined {
  return BEARER_PATTERN.exec(c.req.header('authorization') ?? '')?.[1];
}

/** 認証する。失敗は UNAUTHENTICATED。成功したら、認証済みの利用者をコンテキストに設定する。 */
export async function authenticateRequest(
  c: Context<AppEnv>,
  authService: AuthService,
): Promise<AuthenticatedUser> {
  const token = bearerTokenOf(c);
  const user = token === undefined ? null : await authService.authenticate(token);
  if (user === null) {
    throw new AppError('UNAUTHENTICATED', '認証が必要です。ログインしてください');
  }
  c.set('user', user);
  return user;
}

/** 操作に必要な権限を、サーバー側で確認する（画面の表示制御だけに頼らない）。 */
export function requirePermission(c: Context<AppEnv>, permission: Permission): void {
  const user = c.get('user');
  if (!user.permissions.includes(permission)) {
    c.get('logger').warn('権限のない操作を拒否しました', { userId: user.userId, permission });
    throw new AppError('FORBIDDEN', 'この操作を行う権限がありません');
  }
}

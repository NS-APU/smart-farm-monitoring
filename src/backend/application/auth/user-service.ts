/**
 * ユーザー管理のユースケース（UC-14。FR-9.4）。ユーザーID・ユーザー名・パスワード・ロール。
 * パスワードは、資格情報のポート（CredentialPort）に預け、応答・ログ・変更履歴に含めない（FR-9.2）。
 * 預け先は、ローカルならユーザーの記録のハッシュ、Cognito なら Cognito（ADR-0008）。
 * 預け先と、ユーザーの記録（名前・ロール）は、別々に書くため、途中で失敗しても、ログインできる状態や、
 * 残った資格情報で別のユーザーが作られる状態にならない順序で書く（作成: 資格情報 → 記録、削除: 資格情報 → 記録）。
 * ログイン中のユーザー自身は削除できない（誰もログインできなくなることを防ぐ）。
 * ユーザーを削除したら、そのユーザーのセッションと Web Push の購読も削除し、パスワードを再設定したら、
 * そのユーザーのセッションを失効する（削除後も通知が届き続ける・削除前のトークンが再登録で復活する、ことを防ぐ）。
 */

import { AppError, conflictError, validationError } from '@smart-farm/shared/errors';
import type { UserId } from '@smart-farm/shared/schemas/common';
import type {
  PublicUser,
  UserCreateRequest,
  UserListResponse,
  UserUpdateRequest,
} from '@smart-farm/shared/schemas/auth';
import { omitUndefined } from '@smart-farm/shared/omit-undefined';
import type { AuditTargetType } from '@smart-farm/shared/schemas/audit';
import type { AuditService } from '../audit/audit-service.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { CredentialPort } from '../ports/credential-port.ts';
import type { UserRecord } from '../ports/records.ts';
import type { PushSubscriptionRepository, UserRepository } from '../ports/repositories.ts';
import type { AccessPolicy } from './access-policy.ts';

const USER_TARGET_TYPE = 'user' satisfies AuditTargetType;

export interface UserService {
  list(): Promise<UserListResponse>;
  create(input: UserCreateRequest, actor: UserId): Promise<PublicUser>;
  /**
   * ユーザーを更新する。パスワードを再設定した場合は、そのユーザーのセッションを失効する
   * （操作者が自分自身の場合は、操作に使った現在のアクセストークンのセッションだけを残す）。
   */
  update(
    userId: UserId,
    input: UserUpdateRequest,
    actor: UserId,
    options?: { readonly currentAccessToken?: string },
  ): Promise<PublicUser>;
  delete(userId: UserId, actor: UserId): Promise<void>;
}

export interface UserServiceDeps {
  readonly users: UserRepository;
  readonly policy: AccessPolicy;
  /** パスワードの預け先。 */
  readonly credentials: CredentialPort;
  readonly audit: AuditService;
  readonly clock: ClockPort;
  /** セッションの失効（AuthPort の一部）。 */
  readonly sessions: Pick<AuthPort, 'revokeSessionsOf'>;
  readonly pushSubscriptions: PushSubscriptionRepository;
}

/** パスワードのハッシュを含まない形（応答・変更履歴用）。 */
function toPublicUser(user: UserRecord): PublicUser {
  return {
    userId: user.userId,
    userName: user.userName,
    role: user.role,
    ...omitUndefined({ lastLoginAt: user.lastLoginAt }),
  };
}

export function createUserService(deps: UserServiceDeps): UserService {
  const { users, policy, credentials, audit, clock, sessions, pushSubscriptions } = deps;

  function assertKnownRole(role: string): void {
    if (!policy.isKnownRole(role)) {
      throw validationError([{ name: 'role', message: '定義されていないロールです' }]);
    }
  }

  /**
   * ユーザー管理の権限を持つ利用者が、1人も残らなくなる変更（最後の管理者を、権限のないロールへ変更する）を拒否する。
   * 画面からは回復できなくなる（初期ユーザーの作成は、ユーザーが0人のときだけ）ため（V-010）。
   */
  async function assertUserManagerRemains(userId: UserId, newRole: string): Promise<void> {
    if (policy.can(newRole, 'user:manage')) {
      return;
    }
    const others = (await users.list()).filter(
      (user) => user.userId !== userId && policy.can(user.role, 'user:manage'),
    );
    if (others.length === 0) {
      throw new AppError(
        'CONFLICT',
        'ユーザーを管理できる利用者が、1人もいなくなるため、このロールには変更できません',
      );
    }
  }

  async function findUser(userId: UserId): Promise<UserRecord> {
    const found = await users.get(userId);
    if (found === undefined) {
      throw new AppError('NOT_FOUND', 'ユーザーが見つかりません');
    }
    return found;
  }

  return {
    async list() {
      return {
        items: (await users.list()).map(toPublicUser),
        roles: [...policy.roleOptions()],
      };
    },

    async create(input, actor) {
      assertKnownRole(input.role);
      if ((await users.get(input.userId)) !== undefined) {
        throw conflictError('userId', '同じユーザーIDがすでに登録されています');
      }
      const stored = await credentials.register(input.userId, input.password);
      const created: UserRecord = {
        userId: input.userId,
        userName: input.userName,
        role: input.role,
        ...stored,
        createdAt: clock.now().toISOString(),
      };
      try {
        await users.save(created);
      } catch (error) {
        // 記録を書けなかったら、預けた資格情報を戻す（記録のない資格情報を、残さない）。戻せなくても、元のエラーを返す
        await credentials.remove(created.userId).catch(() => undefined);
        throw error;
      }
      await audit.record({
        operation: 'CREATE',
        targetType: USER_TARGET_TYPE,
        targetId: created.userId,
        actor,
        after: toPublicUser(created),
      });
      return toPublicUser(created);
    },

    async update(userId, input, actor, options = {}) {
      const before = await findUser(userId);
      assertKnownRole(input.role);
      await assertUserManagerRemains(userId, input.role);
      const stored =
        input.password === undefined ? {} : await credentials.reset(userId, input.password);
      const updated: UserRecord = {
        ...before,
        userName: input.userName,
        role: input.role,
        ...stored,
      };
      await users.save(updated);
      if (input.password !== undefined) {
        await sessions.revokeSessionsOf(
          userId,
          userId === actor && options.currentAccessToken !== undefined
            ? { keepAccessToken: options.currentAccessToken }
            : {},
        );
      }
      await audit.record({
        operation: 'UPDATE',
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        actor,
        before: toPublicUser(before),
        after: toPublicUser(updated),
      });
      return toPublicUser(updated);
    },

    async delete(userId, actor) {
      const before = await findUser(userId);
      if (userId === actor) {
        throw new AppError('CONFLICT', 'ログイン中のユーザー自身は削除できません');
      }
      // 資格情報を先に消す（記録だけが消え、資格情報が残る状態にしない。失敗したら、記録は残り、やり直せる）
      await credentials.remove(userId);
      await users.delete(userId);
      await sessions.revokeSessionsOf(userId);
      await pushSubscriptions.deleteByUser(userId);
      await audit.record({
        operation: 'DELETE',
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        actor,
        before: toPublicUser(before),
      });
    },
  };
}

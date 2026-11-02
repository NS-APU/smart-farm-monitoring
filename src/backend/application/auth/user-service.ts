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
import type { AuthPort, AuthSession } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { CredentialPort } from '../ports/credential-port.ts';
import type { UserRecord } from '../ports/records.ts';
import type { PushSubscriptionRepository, UserRepository } from '../ports/repositories.ts';
import type { AccessPolicy } from './access-policy.ts';

const USER_TARGET_TYPE = 'user' satisfies AuditTargetType;

/**
 * 全セッションの失効のあと、新しいパスワードでログインしても、そのセッションが、失効として扱われることがある
 * （Cognito は、失効と同じ秒に発行したトークンを、失効として扱う。評価環境で確認）。有効になるまで、間を置いて、やり直す。
 */
const NEW_SESSION_RETRY_DELAY_MS = 700;
const NEW_SESSION_MAX_RETRIES = 3;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** パスワードの変更の入力（本人。現在のパスワードと、新しいパスワード）。 */
export interface ChangeOwnPasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

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
  /**
   * 本人が、自分のパスワードを変更する（FR-9.7。D-45）。現在のパスワードの確認（誤りは、ログインの失敗と同じく、接続元ごとの
   * 制限に数える）→ 新しいパスワードの設定 → 「変更が必要」の印を外す → すべてのセッションを失効 → 新しいセッションを返す。
   * 現在のパスワードの誤りは、VALIDATION_ERROR（currentPassword）。新しいパスワードが現在と同じなら、VALIDATION_ERROR（newPassword）。
   */
  changeOwnPassword(
    userId: UserId,
    input: ChangeOwnPasswordInput,
    clientKey: string,
  ): Promise<AuthSession>;
}

export interface UserServiceDeps {
  readonly users: UserRepository;
  readonly policy: AccessPolicy;
  /** パスワードの預け先。 */
  readonly credentials: CredentialPort;
  readonly audit: AuditService;
  readonly clock: ClockPort;
  /** セッションの失効・現在のパスワードの確認と新しいセッションの発行（ログイン。AuthPort の一部）。 */
  readonly sessions: Pick<AuthPort, 'login' | 'revokeSessionsOf' | 'verifyAccessToken'>;
  /** 新しいセッションが有効になるのを待つ間隔（ミリ秒）の待ち。既定は、実際の待ち（テストで差し替える）。 */
  readonly delay?: (milliseconds: number) => Promise<void>;
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
  const delay = deps.delay ?? wait;

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

  /**
   * 新しいパスワードで、ログインして、有効なセッションを返す。失効として扱われたら（直前の全セッションの失効と同じ秒の発行）、
   * 間を置いて、やり直す。やり直しても有効にならなければ、パスワードは変更済みのため、ログインし直す旨を伝える。
   */
  async function issueSession(
    userId: UserId,
    password: string,
    clientKey: string,
  ): Promise<AuthSession> {
    for (let retry = 0; retry <= NEW_SESSION_MAX_RETRIES; retry += 1) {
      const session = await sessions.login({ userId, password }, clientKey);
      if ((await sessions.verifyAccessToken(session.accessToken)) !== null) {
        return session;
      }
      if (retry < NEW_SESSION_MAX_RETRIES) {
        await delay(NEW_SESSION_RETRY_DELAY_MS);
      }
    }
    throw new AppError(
      'UNAUTHENTICATED',
      'パスワードを変更しました。新しいパスワードで、ログインし直してください',
    );
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
        // 管理者が決めたパスワードは、一時のもの。本人が、最初のログインで、変更する（D-45）
        mustChangePassword: true,
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
        // 管理者が、他の利用者のパスワードを再設定したら、再設定したパスワードも、一時のもの（D-45）。
        // 自分自身のパスワードは、自分で決めたため、強制しない
        ...(input.password !== undefined && userId !== actor ? { mustChangePassword: true } : {}),
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

    async changeOwnPassword(userId, input, clientKey) {
      if (input.newPassword === input.currentPassword) {
        throw validationError([
          {
            name: 'newPassword',
            message: '新しいパスワードは、現在のパスワードと違うものにしてください',
          },
        ]);
      }
      // 現在のパスワードの確認は、ログインと同じ手順（失敗は、接続元ごとの制限に数える）
      try {
        await sessions.login({ userId, password: input.currentPassword }, clientKey);
      } catch (error) {
        if (error instanceof AppError && error.code === 'UNAUTHENTICATED') {
          throw validationError([
            { name: 'currentPassword', message: '現在のパスワードが正しくありません' },
          ]);
        }
        throw error;
      }
      const before = await findUser(userId);
      const stored = await credentials.reset(userId, input.newPassword);
      const updated: UserRecord = { ...before, ...stored, mustChangePassword: false };
      await users.save(updated);
      // 確認に使ったセッションを含め、すべてのセッションを失効し、新しいパスワードで、新しいセッションを作る
      // （Cognito は、端末ごとにセッションを選べないため、実装によらず、同じ動きにする）
      await sessions.revokeSessionsOf(userId);
      const session = await issueSession(userId, input.newPassword, clientKey);
      await audit.record({
        operation: 'UPDATE',
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        actor: userId,
        before: toPublicUser(before),
        // パスワード・ハッシュは、残さない。変更したことだけを示す
        after: { ...toPublicUser(updated), passwordChanged: true },
      });
      return session;
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

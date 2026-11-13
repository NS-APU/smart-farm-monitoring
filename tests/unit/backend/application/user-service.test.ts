import { describe, expect, it } from 'vitest';
import { toUserId } from '@smart-farm/shared/schemas/common';
import {
  createAccessPolicy,
  DEFAULT_ROLE_CONFIG,
} from '../../../../src/backend/application/auth/access-policy.ts';
import { createUserService } from '../../../../src/backend/application/auth/user-service.ts';
import { createAuditService } from '../../../../src/backend/application/audit/audit-service.ts';
import type { CredentialPort } from '../../../../src/backend/application/ports/credential-port.ts';
import type { UserRepository } from '../../../../src/backend/application/ports/repositories.ts';
import { createControllableClock } from '../../../../src/backend/infrastructure/local/clocks.ts';
import { createSequentialIdGenerator } from '../../../../src/backend/infrastructure/local/ids.ts';
import { createLocalRepositories } from '../../../../src/backend/infrastructure/local/local-repositories.ts';

const NOW = new Date('2026-10-09T03:00:00.000Z');
const ACTOR = toUserId('admin-user');
const NEW_USER = {
  userId: toUserId('new-user'),
  userName: '新しいユーザー',
  password: 'Dummy-Passw0rd-2',
  role: 'admin',
};

/** 呼び出しを記録する、資格情報の預け先（資格情報を、ユーザーの記録の外に持つ実装）。 */
function recordingCredentials(options: { failRemove?: boolean } = {}) {
  const calls: string[] = [];
  const credentials: CredentialPort = {
    register(userId) {
      calls.push(`register:${userId}`);
      return Promise.resolve({});
    },
    reset(userId) {
      calls.push(`reset:${userId}`);
      return Promise.resolve({});
    },
    remove(userId) {
      calls.push(`remove:${userId}`);
      return options.failRemove === true
        ? Promise.reject(new Error('remove failed'))
        : Promise.resolve();
    },
  };
  return { credentials, calls };
}

function build(users: (original: UserRepository) => UserRepository, credentials: CredentialPort) {
  const clock = createControllableClock(NOW);
  clock.freeze(NOW);
  const { repositories } = createLocalRepositories();
  const wrapped = users(repositories.users);
  const audit = createAuditService({
    auditLogs: repositories.auditLogs,
    clock,
    ids: createSequentialIdGenerator('audit'),
  });
  const service = createUserService({
    users: wrapped,
    policy: createAccessPolicy(DEFAULT_ROLE_CONFIG),
    credentials,
    audit,
    clock,
    sessions: {
      login: () => Promise.reject(new Error('このテストでは使わない')),
      revokeSessionsOf: () => Promise.resolve(),
      verifyAccessToken: () => Promise.resolve(null),
    },
    pushSubscriptions: repositories.pushSubscriptions,
    facilityAccess: repositories.facilityAccess,
  });
  return { service, users: repositories.users, audit };
}

describe('ユーザー管理（資格情報の預け先が、ユーザーの記録の外にあるとき）', () => {
  it('作成: 資格情報を預けてから、記録を書く。記録に、パスワードのハッシュは持たない', async () => {
    const { credentials, calls } = recordingCredentials();
    const { service, users } = build((original) => original, credentials);

    await service.create(NEW_USER, ACTOR);

    expect(calls).toEqual(['register:new-user']);
    expect((await users.get(NEW_USER.userId))?.passwordHash).toBeUndefined();
  });

  it('作成: 記録を書けなかったら、預けた資格情報を戻し、元のエラーを返す', async () => {
    const { credentials, calls } = recordingCredentials();
    const { service } = build(
      (original) => ({ ...original, save: () => Promise.reject(new Error('disk full')) }),
      credentials,
    );

    await expect(service.create(NEW_USER, ACTOR)).rejects.toThrow('disk full');

    expect(calls).toEqual(['register:new-user', 'remove:new-user']);
  });

  it('作成: 資格情報を戻せなくても、元のエラーを返す', async () => {
    const { credentials } = recordingCredentials({ failRemove: true });
    const { service } = build(
      (original) => ({ ...original, save: () => Promise.reject(new Error('disk full')) }),
      credentials,
    );

    await expect(service.create(NEW_USER, ACTOR)).rejects.toThrow('disk full');
  });

  it('更新: パスワードを変えなければ、資格情報には触れない。変えれば、再設定する', async () => {
    const { credentials, calls } = recordingCredentials();
    const { service } = build((original) => original, credentials);
    await service.create(NEW_USER, ACTOR);

    await service.update(NEW_USER.userId, { userName: '改名後', role: NEW_USER.role }, ACTOR);
    await service.update(
      NEW_USER.userId,
      { userName: '改名後', role: NEW_USER.role, password: 'Dummy-Passw0rd-3' },
      ACTOR,
    );

    expect(calls).toEqual(['register:new-user', 'reset:new-user']);
  });

  it('削除: 資格情報を先に消す。消せなかったら、記録は残り、やり直せる', async () => {
    const { credentials } = recordingCredentials({ failRemove: true });
    const { service, users } = build((original) => original, credentials);
    await service.create(NEW_USER, ACTOR);

    await expect(service.delete(NEW_USER.userId, ACTOR)).rejects.toThrow('remove failed');

    expect(await users.get(NEW_USER.userId)).toBeDefined();
  });

  it('削除: 資格情報を消してから、記録を消す', async () => {
    const { credentials, calls } = recordingCredentials();
    const { service, users } = build((original) => original, credentials);
    await service.create(NEW_USER, ACTOR);

    await service.delete(NEW_USER.userId, ACTOR);

    expect(calls).toEqual(['register:new-user', 'remove:new-user']);
    expect(await users.get(NEW_USER.userId)).toBeUndefined();
  });
});

describe('自身のユーザー名の編集（FR-9.7）', () => {
  it('ユーザー名だけを変える。ロール・資格情報（パスワード）・セッションには触れない', async () => {
    const { credentials, calls } = recordingCredentials();
    const { service, users } = build((original) => original, credentials);
    await service.create(NEW_USER, ACTOR);

    const updated = await service.updateOwnProfile(NEW_USER.userId, {
      userName: '自分で変えた名前',
    });

    expect(updated).toEqual({
      userId: NEW_USER.userId,
      userName: '自分で変えた名前',
      role: NEW_USER.role,
    });
    expect((await users.get(NEW_USER.userId))?.userName).toBe('自分で変えた名前');
    expect(calls).toEqual(['register:new-user']);
  });

  it('操作履歴に、操作者を本人として、変更前・変更後を残す（パスワードのハッシュは、含めない）', async () => {
    const { credentials } = recordingCredentials();
    const { service, audit } = build((original) => original, credentials);
    await service.create(NEW_USER, ACTOR);

    await service.updateOwnProfile(NEW_USER.userId, { userName: '履歴の確認' });

    const entry = (await audit.list({ operation: 'UPDATE', limit: 10 })).items.find(
      (item) => item.targetType === 'user',
    );
    expect(entry).toMatchObject({
      targetId: NEW_USER.userId,
      actor: NEW_USER.userId,
      before: { userName: NEW_USER.userName },
      after: { userName: '履歴の確認' },
    });
  });

  it('存在しないユーザーは、見つからない（NOT_FOUND）', async () => {
    const { credentials } = recordingCredentials();
    const { service } = build((original) => original, credentials);

    await expect(
      service.updateOwnProfile(toUserId('nobody'), { userName: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

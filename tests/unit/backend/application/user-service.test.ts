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
  role: 'worker',
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
  const service = createUserService({
    users: wrapped,
    policy: createAccessPolicy(DEFAULT_ROLE_CONFIG),
    credentials,
    audit: createAuditService({
      auditLogs: repositories.auditLogs,
      clock,
      ids: createSequentialIdGenerator('audit'),
    }),
    clock,
    sessions: { revokeSessionsOf: () => Promise.resolve() },
    pushSubscriptions: repositories.pushSubscriptions,
  });
  return { service, users: repositories.users };
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

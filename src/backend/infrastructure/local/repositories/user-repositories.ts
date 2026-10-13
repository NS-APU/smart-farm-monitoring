/** ユーザーと Web Push の購読の Repository（ローカル実装）。 */

import {
  PushSubscriptionRecordSchema,
  UserRecordSchema,
} from '../../../application/ports/records.ts';
import type {
  PushSubscriptionRepository,
  UserRepository,
} from '../../../application/ports/repositories.ts';
import type { LocalStore } from '../local-store.ts';
import { deleterOf, saverOf } from './collection-helpers.ts';

export function createUserRepository(store: LocalStore): UserRepository {
  const users = store.collection('users', UserRecordSchema, (item) => item.userId);
  return {
    get: (userId) => Promise.resolve(users.get(userId)),
    list: () =>
      Promise.resolve(
        users.values().sort((left, right) => left.userId.localeCompare(right.userId)),
      ),
    save: saverOf(users),
    delete: deleterOf(users),
  };
}

export function createPushSubscriptionRepository(store: LocalStore): PushSubscriptionRepository {
  const pushSubscriptions = store.collection(
    'pushSubscriptions',
    PushSubscriptionRecordSchema,
    (item) => item.subscriptionId,
  );
  return {
    save: saverOf(pushSubscriptions),
    listActive: () => Promise.resolve(pushSubscriptions.values().filter((item) => item.isActive)),
    listByUser: (userId) =>
      Promise.resolve(
        pushSubscriptions
          .values()
          .filter((item) => item.userId === userId)
          .sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId)),
      ),
    delete: deleterOf(pushSubscriptions),
    deactivate(subscriptionId) {
      const subscription = pushSubscriptions.get(subscriptionId);
      if (subscription !== undefined) {
        pushSubscriptions.put({ ...subscription, isActive: false });
      }
      return Promise.resolve();
    },
    deleteByUser(userId) {
      for (const subscription of pushSubscriptions.values()) {
        if (subscription.userId === userId) {
          pushSubscriptions.delete(subscription.subscriptionId);
        }
      }
      return Promise.resolve();
    },
  };
}

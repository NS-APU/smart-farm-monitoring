/** ユーザーと Web Push の購読の Repository（DynamoDB 実装）。少量のため、パーティションの全件を読む。 */

import { PushSubscriptionRecordSchema, UserRecordSchema } from '../../application/ports/records.ts';
import type {
  PushSubscriptionRepository,
  UserRepository,
} from '../../application/ports/repositories.ts';
import { mainAggregate } from './main-table.ts';
import { batchWriteItems, updateItemIf, type Database } from './operations.ts';

const USER = 'USER';
const PUSH = 'PUSH';

export function createUserRepository(db: Database): UserRepository {
  const users = mainAggregate(db, UserRecordSchema);
  return {
    get: (userId) => users.get(USER, userId),
    async list() {
      return (await users.list(USER)).sort((left, right) =>
        left.userId.localeCompare(right.userId),
      );
    },
    save: (user) => users.put(USER, user.userId, user),
    delete: (userId) => users.remove(USER, userId),
  };
}

export function createPushSubscriptionRepository(db: Database): PushSubscriptionRepository {
  const subscriptions = mainAggregate(db, PushSubscriptionRecordSchema);
  return {
    save: (subscription) => subscriptions.put(PUSH, subscription.subscriptionId, subscription),
    async listActive() {
      return (await subscriptions.list(PUSH)).filter((item) => item.isActive);
    },
    async listByUser(userId) {
      return (await subscriptions.list(PUSH))
        .filter((item) => item.userId === userId)
        .sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
    },
    delete: (subscriptionId) => subscriptions.remove(PUSH, subscriptionId),
    async deactivate(subscriptionId) {
      // 購読がなければ、何もしない（条件つきの更新。なくても作らない）
      await updateItemIf(db, db.tables.main, {
        key: { pk: PUSH, sk: subscriptionId },
        update: 'SET #d.#a = :inactive',
        condition: 'attribute_exists(pk)',
        names: { '#d': 'data', '#a': 'isActive' },
        values: { ':inactive': false },
      });
    },
    async deleteByUser(userId) {
      const owned = (await subscriptions.list(PUSH)).filter((item) => item.userId === userId);
      await batchWriteItems(
        db,
        db.tables.main,
        owned.map((item) => ({ delete: { pk: PUSH, sk: item.subscriptionId } })),
      );
    },
  };
}

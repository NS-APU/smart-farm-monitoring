/**
 * 通知の宛先（Web Push の配信先。Issue #331。ADR-0013・ADR-0019 の D-41）。通知を受け取れる利用者は、その通知のハウスを閲覧できる利用者:
 * 全設備を閲覧する権限をもつ利用者（既定では管理者）と、そのハウスに割り当てた一般ユーザー。
 * ハウスに属さない通知（`facilityId` なし。取り込みの失敗・取得停止・連携の期限切れ。記録にない以前の通知を含む）は、全設備を閲覧できる利用者だけ。
 * 存在しないユーザーは、含めない。
 */

import type { EquipmentId, UserId } from '@smart-farm/shared/schemas/common';
import type { AccessPolicy } from '../auth/access-policy.ts';
import type { Repositories } from '../ports/repositories.ts';

export interface NotificationRecipients {
  /** 通知のハウスを閲覧できる利用者（ハウスなしは、全設備を閲覧できる利用者だけ）。 */
  recipientsOf(facilityId: EquipmentId | undefined): Promise<ReadonlySet<UserId>>;
}

export function createNotificationRecipients(deps: {
  readonly repositories: Pick<Repositories, 'users' | 'facilityAccess'>;
  readonly policy: AccessPolicy;
}): NotificationRecipients {
  const { users, facilityAccess } = deps.repositories;
  return {
    async recipientsOf(facilityId) {
      const all = await users.list();
      const recipients = new Set<UserId>(
        all
          .filter((user) => deps.policy.can(user.role, 'equipment:view-all'))
          .map((user) => user.userId),
      );
      if (facilityId !== undefined) {
        const assigned = (await facilityAccess.get(facilityId))?.userIds ?? [];
        const existing = new Set(all.map((user) => user.userId));
        for (const userId of assigned) {
          if (existing.has(userId)) {
            recipients.add(userId);
          }
        }
      }
      return recipients;
    },
  };
}

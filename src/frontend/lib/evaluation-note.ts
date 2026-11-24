/**
 * 保存・変更の結果の通知に、評価の状態に応じた補足を加える（Issue #404。ADR-0014）。
 * 応答の評価の状態が `DEFERRED`（AWS）のときは、評価の更新が定期の評価で行われ、反映に数分かかる旨を、メッセージの後に加える。
 * `DONE`・項目なしのときは、メッセージのまま。
 */

import type { EvaluationWriteState } from '@smart-farm/shared/schemas/common';
import { MESSAGES } from '../i18n/messages.ts';

export function withEvaluationNote(
  message: string,
  evaluation: EvaluationWriteState | undefined,
): string {
  return evaluation === 'DEFERRED' ? `${message}。${MESSAGES.form.evaluationDeferred}` : message;
}

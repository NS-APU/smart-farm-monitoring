/**
 * ステータスコードから、走行情報・姿勢異常・故障の状態を判定する（FR-3.3。純粋関数）。
 * 判定の対応表は、ロボットのコード仕様が未提供のため暫定（Q-001, Q-003）。
 * 定義にないコード値は「不正な値」として区別する（FR-1.6）。
 */

import type { JudgedStatus } from '@smart-farm/shared/constants/status';
import type { StatusCodeDefinition } from '@smart-farm/shared/schemas/status-code';

export type MotionState = 'RUNNING' | 'STOPPED';

export type RobotState =
  | { readonly isDefined: false; readonly code: string }
  | {
      readonly isDefined: true;
      readonly code: string;
      readonly category: JudgedStatus;
      /** 走行／停止。 */
      readonly motion: MotionState;
      /** 姿勢異常（転倒など）。 */
      readonly isPostureError: boolean;
      /** 故障・異常（カテゴリが異常）。 */
      readonly isFault: boolean;
    };

const RUNNING_CODES: ReadonlySet<string> = new Set(['RUNNING', 'HARVESTING']);
const POSTURE_ERROR_CODES: ReadonlySet<string> = new Set(['FALLEN']);

export function describeRobotState(
  code: string,
  definitions: ReadonlyMap<string, StatusCodeDefinition>,
): RobotState {
  const definition = definitions.get(code);
  if (definition === undefined || definition.isDeleted) {
    return { isDefined: false, code };
  }
  return {
    isDefined: true,
    code,
    category: definition.category,
    motion: RUNNING_CODES.has(code) ? 'RUNNING' : 'STOPPED',
    isPostureError: POSTURE_ERROR_CODES.has(code),
    isFault: definition.category === 'ERROR',
  };
}

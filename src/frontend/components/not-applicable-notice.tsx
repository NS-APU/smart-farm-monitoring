/**
 * 選んでいる設備では評価しない観点（NOT_FOUND）を開いたときの案内（Issue #156。SC-03・SC-04）。観点の詳細・満足度の詳細
 * （全画面のページ・ダッシュボードのドロワー）で共通に使う。エラーではないため、中立の見た目（情報）の `role="status"` にする。
 * 選んでいる設備がロボット・センサーなら、親のハウス（評価する設備）へ、その場で切り替えるボタンを付ける。
 * ハウスを選んでいるとき（存在しない観点など）は、切り替え先がないため、設備の選び直しを案内する。
 */

import type { ReactNode } from 'react';
import { EQUIPMENT_TYPE_LABELS } from '@smart-farm/shared/constants/status';
import { MESSAGES } from '../i18n/messages.ts';
import { useAppState } from './app-state.tsx';
import { Icon } from './icon.tsx';

export function NotApplicableNotice(props: {
  /** サーバーが返した、評価しない旨のメッセージ。 */
  readonly message: string;
  /** 開いた観点の名称（分かるとき）。 */
  readonly viewpointName?: string | undefined;
}): ReactNode {
  const {
    equipmentList,
    equipmentNames,
    selectedEquipmentId,
    selectedFacilityId,
    selectEquipment,
  } = useAppState();
  const selected = equipmentList.find((item) => item.equipmentId === selectedEquipmentId);
  const facilityName =
    selectedFacilityId === undefined ? undefined : equipmentNames.get(selectedFacilityId);
  const canSwitch =
    selected !== undefined &&
    selected.equipmentType !== 'FACILITY' &&
    selectedFacilityId !== undefined &&
    facilityName !== undefined;

  return (
    <div role="status" className="notice notice-info" data-testid="not-applicable">
      <Icon name="info" size={18} />
      <p>{props.message}</p>
      {canSwitch ? (
        <>
          <p>
            {MESSAGES.viewpoint.notApplicableFacilityOnly(
              props.viewpointName,
              EQUIPMENT_TYPE_LABELS[selected.equipmentType],
            )}
          </p>
          <p className="notice-links">
            <button
              type="button"
              onClick={() => {
                selectEquipment(selectedFacilityId);
              }}
            >
              {MESSAGES.viewpoint.showFacility(facilityName)}
            </button>
          </p>
        </>
      ) : (
        <p>{MESSAGES.viewpoint.notApplicable}</p>
      )}
    </div>
  );
}

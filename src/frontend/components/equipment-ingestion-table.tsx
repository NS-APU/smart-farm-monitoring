/**
 * SC-11 取り込みの、取り込み元ごとの「設備ごとの接続と状況」の表（Issue #367。ADR-0026）。設備名・ファイルのパス・接続先・
 * 認証情報の状態・最終の実行・結果・最後にデータが取れた日時・停止中・操作（接続テスト・接続を設定・修正）。
 * 停止中は、ダッシュボードの「データが古い」と同じ基準（取得間隔 × 倍数、最低 3 分。ADR-0016 の D-12）で判定する。
 * 接続・認証情報の入力は、設備のダイアログ（SC-10）で行う（この表には、入力欄を持たない）。
 * 取り込みの設定の権限がある利用者には、ファイルのパスがある設備の行に、「ファイルを置く」を出す（Issue #565。ダイアログは、呼び出し側が開く）。
 */

import type { ReactNode } from 'react';
import {
  describeConnectionTarget,
  type IngestionSourceStatus,
} from '@smart-farm/shared/schemas/ingestion';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { judgeStopped } from './equipment-connection.ts';
import { formatDateTimeJst } from './format.ts';
import { ResultNotice } from './result-notice.tsx';

const TEXT = MESSAGES.ingestion;
const CONNECTION_TEXT = MESSAGES.equipment.connection;

/** 設備の接続テストの結果の表示。 */
export interface EquipmentTestResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface EquipmentIngestionTableProps {
  readonly source: IngestionSourceStatus;
  /** 接続テストができる（取り込みの実行の権限がある）。 */
  readonly canRun: boolean;
  /** 設備のダイアログへのリンクを出す（設備を変更する権限がある）。 */
  readonly canOpenEquipment: boolean;
  /** 操作を受け付けない（実行中）。 */
  readonly locked: boolean;
  /** 接続テストを実行している設備。 */
  readonly testingId: string | undefined;
  readonly results: Readonly<Record<string, EquipmentTestResult | undefined>>;
  readonly onTest: (equipmentId: string) => void;
  /** 「ファイルを置く」を出す（取り込みの設定の権限がある。Issue #565）。ファイルのパスがある設備の行にだけ出す。 */
  readonly canPlaceFile: boolean;
  readonly onPlaceFile: (equipmentId: string) => void;
  /** 判定の基準の時刻。 */
  readonly now: Date;
  readonly sourceLabel: string;
}

export function EquipmentIngestionTable(props: EquipmentIngestionTableProps): ReactNode {
  const { source } = props;
  if (source.equipment.length === 0) {
    return (
      <p className="muted" data-testid={`equipment-empty-${source.sourceId}`}>
        {TEXT.equipmentEmpty}
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table
        className="data-table card-table equipment-runs"
        aria-label={`${props.sourceLabel}の${TEXT.equipmentRuns}`}
      >
        <thead>
          <tr>
            <th scope="col">{TEXT.logEquipment}</th>
            <th scope="col">{TEXT.equipmentFilePath}</th>
            <th scope="col">{TEXT.equipmentConnectionTarget}</th>
            <th scope="col">{TEXT.equipmentCredentials}</th>
            <th scope="col">{TEXT.equipmentLastRun}</th>
            <th scope="col">{TEXT.equipmentRunData}</th>
            <th scope="col">{TEXT.equipmentActions}</th>
          </tr>
        </thead>
        <tbody>
          {source.equipment.map((item) => {
            const target = describeConnectionTarget(item.connection);
            const stopped = judgeStopped({
              isEnabled: source.isEnabled,
              sourceFilePath: item.sourceFilePath,
              staleThresholdMinutes: item.staleThresholdMinutes,
              lastDataAt: item.lastDataAt,
              now: props.now,
            });
            const result = props.results[item.equipmentId];
            return (
              <tr key={item.equipmentId} data-testid={`equipment-run-${item.equipmentId}`}>
                <td data-label={TEXT.logEquipment}>{item.name}</td>
                <td data-label={TEXT.equipmentFilePath}>
                  {item.sourceFilePath === undefined ? (
                    <span className="muted" data-testid={`equipment-nopath-${item.equipmentId}`}>
                      {TEXT.equipmentFilePathNone}
                    </span>
                  ) : (
                    <span data-testid={`equipment-path-${item.equipmentId}`}>
                      {item.sourceFilePath}
                    </span>
                  )}
                </td>
                <td data-label={TEXT.equipmentConnectionTarget}>
                  <span data-testid={`equipment-target-${item.equipmentId}`}>
                    {target ?? TEXT.equipmentConnectionUnset}
                  </span>
                </td>
                <td data-label={TEXT.equipmentCredentials}>
                  <span data-testid={`equipment-credentials-${item.equipmentId}`}>
                    {item.credentials.state === 'CONFIGURED' &&
                    item.credentials.updatedAt !== undefined
                      ? CONNECTION_TEXT.credentialsUpdatedAt(
                          formatDateTimeJst(item.credentials.updatedAt),
                        )
                      : TEXT.equipmentCredentialsLabels[item.credentials.state]}
                  </span>
                </td>
                <td data-label={TEXT.equipmentLastRun}>
                  <div className="cell-stack">
                    <span>
                      {item.lastStartedAt === null
                        ? TEXT.neverRun
                        : formatDateTimeJst(item.lastStartedAt)}
                    </span>
                    {item.lastResult === null ? null : (
                      <span
                        className={`log-result log-result-${item.lastResult.toLowerCase()}`}
                        data-testid={`equipment-result-${item.equipmentId}`}
                      >
                        {TEXT.runResultLabels[item.lastResult]}
                      </span>
                    )}
                  </div>
                </td>
                <td data-label={TEXT.equipmentRunData}>
                  <div className="cell-stack">
                    <span data-testid={`equipment-data-${item.equipmentId}`}>
                      {item.lastDataAt === null
                        ? MESSAGES.common.missingValue
                        : formatDateTimeJst(item.lastDataAt)}
                    </span>
                    {stopped.stopped && stopped.thresholdMinutes !== undefined ? (
                      <span
                        className="log-result log-result-failure"
                        title={TEXT.equipmentStoppedTitle(stopped.thresholdMinutes)}
                        data-testid={`equipment-stopped-${item.equipmentId}`}
                      >
                        {TEXT.equipmentStopped}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td data-label={TEXT.equipmentActions}>
                  <div className="row-actions">
                    {props.canRun ? (
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={TEXT.equipmentTestLabel(item.name)}
                        data-testid={`equipment-test-${item.equipmentId}`}
                        disabled={props.locked}
                        onClick={() => {
                          props.onTest(item.equipmentId);
                        }}
                      >
                        {props.testingId === item.equipmentId
                          ? TEXT.equipmentTesting
                          : TEXT.equipmentTest}
                      </button>
                    ) : null}
                    {props.canPlaceFile && item.sourceFilePath !== undefined ? (
                      <button
                        type="button"
                        className="button-secondary"
                        aria-label={TEXT.sourceFile.buttonLabel(item.name)}
                        data-testid={`equipment-place-${item.equipmentId}`}
                        disabled={props.locked}
                        onClick={() => {
                          props.onPlaceFile(item.equipmentId);
                        }}
                      >
                        {TEXT.sourceFile.button}
                      </button>
                    ) : null}
                    {props.canOpenEquipment ? (
                      <Link
                        to={`${PATHS.settingsEquipment}?edit=${encodeURIComponent(item.equipmentId)}`}
                        aria-label={TEXT.equipmentConfigureLabel(item.name)}
                        data-testid={`equipment-configure-${item.equipmentId}`}
                      >
                        {TEXT.equipmentConfigure}
                      </Link>
                    ) : null}
                  </div>
                  <ResultNotice
                    message={result?.text}
                    ok={result?.ok}
                    testId={`equipment-test-result-${item.equipmentId}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * SC-11 取り込みの「ファイルを置く」ダイアログ（Issue #565。ADR-0027。UC-15）。管理者（ingestion:configure）が、設備ごとに、
 * ブラウザから、取り込み用のファイルを、設備のファイルのパスの場所に置く。
 * 流れ: ファイルを選ぶ（JSON。1 MiB まで。超えるときは、送信せず、その場でエラー）→「内容を確認」（置く前の検査。保存しない。
 * 仕様の版・計測日時・項目数・置けない理由・警告）→「置く」→ 確認のダイアログ（同じパスのファイルは置き換わる）→ 置く。
 * 置けない内容（ok: false）は、「置く」を使えない。失敗（400・413・503・通信）は、ダイアログの中に、API のメッセージで示す。
 * 本文は、ファイルの内容そのもの（JSON の包みを付けない）。結果の通知と、取り込みへの導線は、呼び出し側（SC-11）が示す。
 * ファイルの内容・認証情報は、画面に残さない（このダイアログを閉じると、破棄する）。
 */

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  SOURCE_FILE_MAX_BYTES,
  type SourceFileInspection,
  type SourceFilePlaced,
} from '@smart-farm/shared/schemas/ingestion';
import { checkSourceFile, placeSourceFile } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { ConfirmDialog, Field, FormError } from './form-controls.tsx';
import { formatDateTimeJst, formatFileSize } from './format.ts';
import { Icon } from './icon.tsx';
import { Modal } from './modal.tsx';

const TEXT = MESSAGES.ingestion.sourceFile;

/** 選んだファイル（名前・大きさ・読み取った内容）。 */
interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly content: string;
}

export interface SourceFileDialogProps {
  readonly equipmentId: string;
  readonly equipmentName: string;
  /** 設備のファイルのパス（置き先。示すだけ）。 */
  readonly sourceFilePath: string;
  readonly onClose: () => void;
  /** 置けたとき（このダイアログは、呼び出し側が閉じる）。 */
  readonly onPlaced: (placed: SourceFilePlaced) => void;
}

function InspectionView(props: { readonly inspection: SourceFileInspection }): ReactNode {
  const { inspection } = props;
  return (
    <section
      className="source-file-inspection"
      aria-label={TEXT.resultHeading}
      data-testid="source-file-inspection"
    >
      <h3>{TEXT.resultHeading}</h3>
      <p
        className={inspection.ok ? 'form-success' : 'form-error'}
        data-testid="source-file-inspection-status"
      >
        <Icon name={inspection.ok ? 'status-normal' : 'status-error'} size={16} />
        {inspection.ok ? TEXT.okText : TEXT.ngText}
      </p>
      <dl className="source-file-info">
        <div>
          <dt>{TEXT.format}</dt>
          <dd data-testid="source-file-format">{inspection.formatLabel}</dd>
        </div>
        <div>
          <dt>{TEXT.observedAt}</dt>
          <dd data-testid="source-file-observed-at">
            {inspection.observedAt === undefined
              ? TEXT.observedAtNone
              : formatDateTimeJst(inspection.observedAt)}
          </dd>
        </div>
        <div>
          <dt>{TEXT.itemCount}</dt>
          <dd data-testid="source-file-item-count">{TEXT.itemCountValue(inspection.itemCount)}</dd>
        </div>
        <div>
          <dt>{TEXT.fileSize}</dt>
          <dd>{formatFileSize(inspection.size)}</dd>
        </div>
      </dl>
      {inspection.problems.length === 0 ? null : (
        <div className="source-file-problems" data-testid="source-file-problems">
          <h4>{TEXT.problemsHeading}</h4>
          <ul>
            {inspection.problems.map((problem) => (
              <li key={problem}>
                <Icon name="status-error" size={16} />
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}
      {inspection.warnings.length === 0 ? null : (
        <div className="notice notice-warning" data-testid="source-file-warnings">
          <Icon name="status-caution" size={18} />
          <p>{TEXT.warningsHeading}</p>
          <ul>
            {inspection.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function SourceFileDialog(props: SourceFileDialogProps): ReactNode {
  const { api } = useAuth();
  const submit = useSubmit();
  const [file, setFile] = useState<PickedFile | undefined>(undefined);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [inspection, setInspection] = useState<SourceFileInspection | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  /** 実行中の操作（実行中の表示を、その操作のボタンだけに出す）。 */
  const [operation, setOperation] = useState<'check' | 'place' | undefined>(undefined);
  /** 内容の読み取りの順番（読み取りの途中で、別のファイルを選んだとき、前のものを捨てる）。 */
  const readSequence = useRef(0);
  const busy = submit.busy;

  function handleClose(): void {
    // 処理中に閉じると、結果（置いたかどうか）を、見失う
    if (!busy) {
      props.onClose();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const picked = event.target.files?.[0];
    readSequence.current += 1;
    const sequence = readSequence.current;
    submit.clearError();
    setFile(undefined);
    setFileError(undefined);
    setInspection(undefined);
    setConfirming(false);
    if (picked === undefined) {
      return;
    }
    if (picked.size > SOURCE_FILE_MAX_BYTES) {
      setFileError(TEXT.tooLarge(picked.size));
      return;
    }
    picked.text().then(
      (content) => {
        if (sequence === readSequence.current) {
          setFile({ name: picked.name, size: picked.size, content });
        }
      },
      () => {
        if (sequence === readSequence.current) {
          setFileError(TEXT.readFailed);
        }
      },
    );
  }

  async function handleCheck(): Promise<void> {
    if (file === undefined) {
      return;
    }
    setInspection(undefined);
    setOperation('check');
    const checked = await submit.run(() => checkSourceFile(api, props.equipmentId, file.content));
    setOperation(undefined);
    if (checked.ok) {
      setInspection(checked.value);
    }
  }

  async function handlePlace(): Promise<void> {
    if (file === undefined || inspection?.ok !== true) {
      return;
    }
    setOperation('place');
    const placed = await submit.run(() => placeSourceFile(api, props.equipmentId, file.content));
    setOperation(undefined);
    if (placed.ok) {
      props.onPlaced(placed.value);
    } else {
      // 失敗の理由は、確認のダイアログの後ろの、このダイアログに示す
      setConfirming(false);
    }
  }

  const canCheck = file !== undefined && !busy;
  const canPlace = file !== undefined && inspection?.ok === true && !busy;

  return (
    <Modal title={TEXT.title} testId="source-file-dialog" onClose={handleClose}>
      <p data-testid="source-file-target">
        <strong>{TEXT.target}: </strong>
        {TEXT.targetValue(props.equipmentName, props.sourceFilePath)}
      </p>
      <p className="muted">{TEXT.lead}</p>
      <Field label={TEXT.fileLabel} name="file" error={fileError} hint={TEXT.fileHint}>
        {(control) => (
          <input
            {...control}
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={handleFileChange}
          />
        )}
      </Field>
      {file === undefined ? null : (
        <p className="source-file-selected" data-testid="source-file-selected">
          {TEXT.selected(file.name, formatFileSize(file.size))}
        </p>
      )}
      <div aria-live="polite">
        {inspection === undefined ? null : <InspectionView inspection={inspection} />}
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={!canCheck}
          onClick={() => {
            void handleCheck();
          }}
        >
          {operation === 'check' ? TEXT.checking : TEXT.check}
        </button>
        <button
          type="button"
          disabled={!canPlace}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {operation === 'place' ? TEXT.placing : TEXT.place}
        </button>
        <button type="button" className="button-secondary" disabled={busy} onClick={handleClose}>
          {MESSAGES.form.cancel}
        </button>
      </div>
      {confirming && file !== undefined && inspection !== undefined ? (
        <ConfirmDialog
          title={TEXT.confirm.title}
          message={TEXT.confirm.message}
          details={[
            { label: TEXT.confirm.equipment, value: props.equipmentName },
            { label: TEXT.confirm.fileName, value: file.name },
            { label: TEXT.confirm.size, value: formatFileSize(file.size) },
            {
              label: TEXT.confirm.observedAt,
              value:
                inspection.observedAt === undefined
                  ? TEXT.observedAtNone
                  : formatDateTimeJst(inspection.observedAt),
            },
          ]}
          notes={TEXT.confirm.notes}
          confirmLabel={operation === 'place' ? TEXT.placing : TEXT.place}
          busy={busy}
          onConfirm={() => {
            void handlePlace();
          }}
          onCancel={() => {
            if (!busy) {
              setConfirming(false);
            }
          }}
        />
      ) : null}
    </Modal>
  );
}

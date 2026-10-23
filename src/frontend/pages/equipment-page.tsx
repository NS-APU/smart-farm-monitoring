/**
 * SC-10 設備管理（UC-12。FR-2）。ハウス → ロボット／環境センサーの階層の表示と、登録・変更・削除（論理削除。確認を求める）。
 * 設備IDは一意（重複はエラー）。ロボット・センサーは、ハウスに属する。変更は、取り込み・評価・表示に反映される。
 * 設備を変更する権限（equipment:manage）がなければ、参照のみ。
 */

import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { EQUIPMENT_TYPES } from '@smart-farm/shared/constants/status';
import {
  EquipmentCreateRequestSchema,
  EquipmentUpdateRequestSchema,
  type Equipment,
} from '@smart-farm/shared/schemas/equipment';
import { createEquipment, deleteEquipment, updateEquipment } from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import { ConfirmDialog, Field, FormError, PermissionNotice } from '../components/form-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { Icon } from '../components/icon.tsx';

const TEXT = MESSAGES.equipment;
const CHILD_TYPES = EQUIPMENT_TYPES.filter((type) => type !== 'FACILITY');

interface FormProps {
  readonly facilities: readonly Equipment[];
  readonly onDone: (message: string) => void;
}

/** ハウスの登録。 */
function FacilityForm(props: Pick<FormProps, 'onDone'>): ReactNode {
  const { api } = useAuth();
  const { reloadEquipment } = useAppState();
  const submit = useSubmit();
  const [equipmentId, setEquipmentId] = useState('');
  const [name, setName] = useState('');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const parsed = EquipmentCreateRequestSchema.safeParse({
      equipmentId,
      equipmentType: 'FACILITY',
      name,
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => createEquipment(api, parsed.data));
    if (result.ok) {
      setEquipmentId('');
      setName('');
      reloadEquipment();
      props.onDone(TEXT.created);
    }
  }

  return (
    <form
      className="inline-form"
      noValidate
      aria-label={TEXT.addFacility}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3>{TEXT.addFacility}</h3>
      <div className="form-grid">
        <Field label={TEXT.id} name="equipmentId" error={errors.equipmentId} required>
          {(control) => (
            <input
              {...control}
              value={equipmentId}
              onChange={(event) => {
                setEquipmentId(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.name} name="name" error={errors.name} required>
          {(control) => (
            <input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {TEXT.addSubmit}
        </button>
      </div>
    </form>
  );
}

/** ロボット・環境センサーの登録（ハウスに紐づける）。 */
function ChildForm(props: FormProps): ReactNode {
  const { api } = useAuth();
  const { reloadEquipment } = useAppState();
  const submit = useSubmit();
  const [equipmentType, setEquipmentType] = useState<string>('ROBOT');
  const [facilityId, setFacilityId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [name, setName] = useState('');
  const [externalId, setExternalId] = useState('');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const parsed = EquipmentCreateRequestSchema.safeParse({
      equipmentId,
      equipmentType,
      name,
      ...(facilityId === '' ? {} : { facilityId }),
      ...(externalId.trim() === '' ? {} : { externalId }),
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => createEquipment(api, parsed.data));
    if (result.ok) {
      setEquipmentId('');
      setName('');
      setExternalId('');
      reloadEquipment();
      props.onDone(TEXT.created);
    }
  }

  return (
    <form
      className="inline-form"
      noValidate
      aria-label={TEXT.addChild}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3>{TEXT.addChild}</h3>
      <div className="form-grid">
        <Field label={TEXT.type} name="equipmentType" error={errors.equipmentType} required>
          {(control) => (
            <select
              {...control}
              value={equipmentType}
              onChange={(event) => {
                setEquipmentType(event.target.value);
              }}
            >
              {CHILD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TEXT.typeLabels[type]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={TEXT.facility} name="facilityId" error={errors.facilityId} required>
          {(control) => (
            <select
              {...control}
              value={facilityId}
              onChange={(event) => {
                setFacilityId(event.target.value);
              }}
            >
              <option value="">{MESSAGES.entry.selectPlaceholder}</option>
              {props.facilities.map((facility) => (
                <option key={facility.equipmentId} value={facility.equipmentId}>
                  {facility.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={TEXT.id} name="equipmentId" error={errors.equipmentId} required>
          {(control) => (
            <input
              {...control}
              value={equipmentId}
              onChange={(event) => {
                setEquipmentId(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={TEXT.name} name="name" error={errors.name} required>
          {(control) => (
            <input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={TEXT.externalId}
          name="externalId"
          error={errors.externalId}
          hint={TEXT.externalIdHint}
        >
          {(control) => (
            <input
              {...control}
              value={externalId}
              onChange={(event) => {
                setExternalId(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {TEXT.addSubmit}
        </button>
      </div>
    </form>
  );
}

/** 設備の修正（名称・データ上の識別子・親のハウス）。設備IDと種別は変更できない。 */
function EditForm(
  props: FormProps & { readonly equipment: Equipment; readonly onCancel: () => void },
): ReactNode {
  const { equipment } = props;
  const { api } = useAuth();
  const { reloadEquipment } = useAppState();
  const submit = useSubmit();
  const [name, setName] = useState(equipment.name);
  const [facilityId, setFacilityId] = useState(equipment.facilityId ?? '');
  const [externalId, setExternalId] = useState(equipment.externalId ?? '');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const errors = { ...clientErrors, ...submit.fieldErrors };
  const isFacility = equipment.equipmentType === 'FACILITY';

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    const parsed = EquipmentUpdateRequestSchema.safeParse({
      name,
      ...(isFacility || facilityId === '' ? {} : { facilityId }),
      ...(externalId.trim() === '' ? {} : { externalId }),
    });
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => updateEquipment(api, equipment.equipmentId, parsed.data));
    if (result.ok) {
      reloadEquipment();
      props.onDone(TEXT.updated);
    }
  }

  return (
    <form
      className="inline-form"
      noValidate
      aria-label={`${equipment.name}を${TEXT.edit}`}
      data-testid="equipment-edit"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <h3>
        {TEXT.typeLabels[equipment.equipmentType]}（{equipment.equipmentId}）を{TEXT.edit}
      </h3>
      <div className="form-grid">
        <Field label={TEXT.name} name="name" error={errors.name} required>
          {(control) => (
            <input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        {isFacility ? null : (
          <Field label={TEXT.facility} name="facilityId" error={errors.facilityId}>
            {(control) => (
              <select
                {...control}
                value={facilityId}
                onChange={(event) => {
                  setFacilityId(event.target.value);
                }}
              >
                {props.facilities.map((facility) => (
                  <option key={facility.equipmentId} value={facility.equipmentId}>
                    {facility.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field
          label={TEXT.externalId}
          name="externalId"
          error={errors.externalId}
          hint={TEXT.externalIdHint}
        >
          {(control) => (
            <input
              {...control}
              value={externalId}
              onChange={(event) => {
                setExternalId(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={submit.busy}>
          {submit.busy ? MESSAGES.form.saving : MESSAGES.form.save}
        </button>
        <button type="button" className="button-secondary" onClick={props.onCancel}>
          {MESSAGES.form.cancel}
        </button>
      </div>
    </form>
  );
}

export function EquipmentPage(): ReactNode {
  const { api } = useAuth();
  const { equipmentTree, equipmentList, equipmentError, reloadEquipment } = useAppState();
  const canManage = usePermission('equipment:manage');
  const submit = useSubmit();
  const [editing, setEditing] = useState<Equipment | undefined>(undefined);
  const [deleting, setDeleting] = useState<Equipment | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const facilities = equipmentTree?.facilities.map((entry) => entry.facility) ?? [];

  /** ハウスの配下の設備の名称（削除の確認で、影響の範囲を示す。V-200）。 */
  function childNamesOf(facility: Equipment): string[] {
    return (
      equipmentTree?.facilities
        .find((entry) => entry.facility.equipmentId === facility.equipmentId)
        ?.children.map((child) => child.name) ?? []
    );
  }

  async function confirmDelete(target: Equipment): Promise<void> {
    const result = await submit.run(() => deleteEquipment(api, target.equipmentId));
    setDeleting(undefined);
    if (result.ok) {
      setNotice(TEXT.deleted);
      reloadEquipment();
    }
  }

  function done(message: string): void {
    setEditing(undefined);
    setNotice(message);
  }

  function row(equipment: Equipment, isChild: boolean): ReactNode {
    return (
      <tr
        key={equipment.equipmentId}
        data-testid="equipment-row"
        data-equipment-id={equipment.equipmentId}
      >
        <td className={isChild ? 'tree-child' : 'tree-parent'}>
          {TEXT.typeLabels[equipment.equipmentType]}
        </td>
        <td>{equipment.equipmentId}</td>
        <td>{equipment.name}</td>
        <td>{equipment.externalId ?? MESSAGES.common.missingValue}</td>
        {canManage ? (
          <td>
            <div className="row-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setNotice(undefined);
                  setEditing(equipment);
                }}
              >
                {TEXT.edit}
              </button>
              <button
                type="button"
                className="button-danger-outline"
                onClick={() => {
                  setNotice(undefined);
                  setDeleting(equipment);
                }}
              >
                {MESSAGES.form.delete}
              </button>
            </div>
          </td>
        ) : null}
      </tr>
    );
  }

  let body: ReactNode;
  if (equipmentError !== undefined) {
    body = <ErrorView error={equipmentError} onRetry={reloadEquipment} />;
  } else if (equipmentTree === undefined) {
    body = <LoadingView />;
  } else if (equipmentTree.facilities.length === 0) {
    body = (
      <EmptyState testId="equipment-empty">
        <p>{TEXT.empty}</p>
      </EmptyState>
    );
  } else {
    body = (
      <div className="table-scroll">
        <table className="data-table equipment-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.type}</th>
              <th scope="col">{TEXT.id}</th>
              <th scope="col">{TEXT.name}</th>
              <th scope="col">{TEXT.externalId}</th>
              {canManage ? <th scope="col">{TEXT.actions}</th> : null}
            </tr>
          </thead>
          <tbody>{equipmentList.map((item) => row(item, item.equipmentType !== 'FACILITY'))}</tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="equipment-page">
      <div className="page-head">
        <h1>{TEXT.title}</h1>
      </div>
      <p className="muted">{TEXT.lead}</p>
      {canManage ? null : <PermissionNotice message={TEXT.readOnly} />}
      {notice === undefined ? null : (
        <p role="status" className="form-success" data-testid="equipment-notice">
          <Icon name="status-normal" size={16} />
          {notice}
        </p>
      )}
      <FormError message={submit.formMessage} />
      <section className="panel" aria-label={TEXT.title}>
        {body}
      </section>
      {canManage && editing !== undefined ? (
        <section className="panel">
          <EditForm
            key={editing.equipmentId}
            equipment={editing}
            facilities={facilities}
            onDone={done}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </section>
      ) : null}
      {canManage ? (
        <section className="panel">
          <div className="forms-row">
            <FacilityForm onDone={done} />
            <ChildForm facilities={facilities} onDone={done} />
          </div>
        </section>
      ) : null}
      {deleting === undefined ? null : (
        <ConfirmDialog
          title={TEXT.deleteTitle}
          message={
            deleting.equipmentType === 'FACILITY'
              ? `${TEXT.deleteFacilityMessage}${TEXT.deleteTargets(childNamesOf(deleting))}`
              : TEXT.deleteMessage
          }
          confirmLabel={MESSAGES.form.delete}
          busy={submit.busy}
          onConfirm={() => {
            void confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(undefined);
          }}
        />
      )}
    </div>
  );
}

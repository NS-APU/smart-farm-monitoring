/**
 * SC-10 設備管理（UC-12。FR-2）。ハウス → ロボット／環境センサーの階層の表示と、登録・変更・削除（論理削除。確認を求める）。
 * 設備IDは一意（重複はエラー）。ロボット・センサーは、ハウスに属する。変更は、取り込み・評価・表示に反映される。
 * 設備を変更する権限（equipment:manage）がなければ、参照のみ。
 * ハウスの行には、ユーザーを管理する権限（user:manage）があれば、閲覧できる一般ユーザーを示し、割り当てる操作を出す（Issue #330。
 * ハウス側から、一般ユーザーを個別に割り当てる。管理者は、すべてのハウスを閲覧できる）。
 * ロボット・環境センサーの登録・修正のダイアログには、「取り込み元の接続」の欄を持つ（取り込みの参照権限 ingestion:read がある利用者だけ。
 * 設備ごとの接続。Issue #367。ADR-0026）。設備を保存してから、接続を保存する。
 */

import { useCallback, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  EQUIPMENT_INTERVAL_MINUTES_OPTIONS,
  EQUIPMENT_TYPES,
} from '@smart-farm/shared/constants/status';
import {
  EquipmentCreateRequestSchema,
  EquipmentUpdateRequestSchema,
  effectiveIntervalMinutes,
  type Equipment,
} from '@smart-farm/shared/schemas/equipment';
import type { IngestionSourceStatus } from '@smart-farm/shared/schemas/ingestion';
import {
  createEquipment,
  deleteEquipment,
  getFacilityAccess,
  getIngestionSettings,
  updateEquipment,
} from '../api/management-endpoints.ts';
import { useAuth } from '../auth/auth-context.tsx';
import { useAppState } from '../components/app-state.tsx';
import {
  copyCandidatesOf,
  findEquipmentStatus,
  type CopyCandidate,
} from '../components/equipment-connection.ts';
import { EquipmentConnectionSection } from '../components/equipment-connection-section.tsx';
import { ConfirmDialog, Field, FormError, PermissionNotice } from '../components/form-controls.tsx';
import { EmptyState, ErrorView, LoadingView } from '../components/state-views.tsx';
import {
  NO_CONNECTION_STATE,
  serverStateOf,
  useEquipmentConnection,
  type EquipmentConnectionController,
} from '../components/use-equipment-connection.ts';
import { fieldErrorsOfZod } from '../components/zod-errors.ts';
import { usePermission } from '../hooks/use-permission.ts';
import { usePolling } from '../hooks/use-polling.ts';
import { useQueryParams } from '../hooks/use-query-params.ts';
import { useSubmit } from '../hooks/use-submit.ts';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';
import { Icon } from '../components/icon.tsx';
import { Modal } from '../components/modal.tsx';
import { FacilityAccessPanel } from './facility-access-panel.tsx';

const TEXT = MESSAGES.equipment;
const CHILD_TYPES = EQUIPMENT_TYPES.filter((type) => type !== 'FACILITY');
/** 取り込み設定・状況（設備ごとの接続）を読み直す間隔。ダイアログを開いている間だけ読む。 */
const INGESTION_REFRESH_MS = 60_000;

/** 取得間隔の選択（設備ごと。Issue #197）。空は、種別ごとの既定。 */
function IntervalField(props: {
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <Field
      label={TEXT.interval}
      name="intervalMinutes"
      error={props.error}
      hint={TEXT.intervalHint}
    >
      {(control) => (
        <select
          {...control}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        >
          <option value="">{TEXT.intervalDefaultOption}</option>
          {EQUIPMENT_INTERVAL_MINUTES_OPTIONS.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {TEXT.intervalOption(minutes)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** 一覧の取得間隔の表示。指定があればその値、なければ種別ごとの既定。ハウスは持たない。 */
function intervalCell(equipment: Equipment): string {
  const effective = effectiveIntervalMinutes(equipment);
  if (effective === undefined) {
    return MESSAGES.common.missingValue;
  }
  return equipment.intervalMinutes === undefined
    ? TEXT.intervalDefault(effective)
    : TEXT.intervalOption(effective);
}

/** 登録・修正の後に、次にすることの案内（SC-10-9）。 */
type NextStep = 'registerChild' | 'dataEntry';

/** ダイアログに出す「取り込み元の接続」の欄の前提（取り込みの参照権限がない利用者には、欄を出さないため、undefined）。 */
interface ConnectionContext {
  /** 取り込み設定・状況（設備ごとの接続を含む）。読み込み中・失敗は undefined。 */
  readonly sources: readonly IngestionSourceStatus[] | undefined;
  readonly loadFailed: boolean;
  readonly canConfigure: boolean;
  readonly canRun: boolean;
  /** 接続を変更したあとに、取り込み設定・状況を読み直す。 */
  readonly reload: () => void;
}

interface FormProps {
  readonly facilities: readonly Equipment[];
  readonly onDone: (message: string, next?: NextStep) => void;
  readonly connection: ConnectionContext | undefined;
}

/** 設備の登録・修正のダイアログの、接続の状態・操作。取り込み元の設備の状況から、保存済みの接続を読み込む。 */
function useConnectionOf(
  equipmentType: Equipment['equipmentType'],
  equipmentId: string | undefined,
  context: ConnectionContext | undefined,
): {
  readonly controller: EquipmentConnectionController;
  readonly copyCandidates: readonly CopyCandidate[];
} {
  const sources = context?.sources;
  // 新規の登録は、接続がない状態から始める。修正は、取り込み設定・状況の、その設備の状況から始める（読み込めるまで待つ）
  const initial =
    equipmentId === undefined
      ? NO_CONNECTION_STATE
      : sources === undefined
        ? undefined
        : (() => {
            const status = findEquipmentStatus(sources, equipmentId);
            return status === undefined ? NO_CONNECTION_STATE : serverStateOf(status);
          })();
  const controller = useEquipmentConnection(initial, context?.reload ?? noop);
  return {
    controller,
    copyCandidates:
      sources === undefined ? [] : copyCandidatesOf(sources, equipmentType, equipmentId),
  };
}

function noop(): void {
  // 取り込みの参照権限がない利用者は、接続を変更しない
}

/** 設備のダイアログの、「取り込み元の接続」の欄（ロボット・環境センサー。取り込みの参照権限があるときだけ）。 */
function ConnectionBlock(props: {
  readonly context: ConnectionContext | undefined;
  readonly controller: EquipmentConnectionController;
  readonly copyCandidates: readonly CopyCandidate[];
  readonly equipmentId: string | undefined;
}): ReactNode {
  if (props.context === undefined) {
    return null;
  }
  return (
    <EquipmentConnectionSection
      controller={props.controller}
      equipmentId={props.equipmentId}
      canConfigure={props.context.canConfigure}
      canRun={props.context.canRun}
      loadFailed={props.context.loadFailed}
      copyCandidates={props.copyCandidates}
    />
  );
}

/** ハウスの登録（ダイアログの中に置く）。 */
function FacilityForm(
  props: Pick<FormProps, 'onDone'> & { readonly onCancel: () => void },
): ReactNode {
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
      props.onDone(TEXT.created, 'registerChild');
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
      <p className="field-note muted" data-testid="equipment-id-rule">
        {TEXT.idRule}
      </p>
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
        <button type="button" className="button-secondary" onClick={props.onCancel}>
          {MESSAGES.form.cancel}
        </button>
      </div>
    </form>
  );
}

/** ロボット・環境センサーの登録（ハウスに紐づける。ダイアログの中に置く）。設備を登録してから、接続（入力があれば）を保存する。 */
function ChildForm(props: FormProps & { readonly onCancel: () => void }): ReactNode {
  const { api } = useAuth();
  const { reloadEquipment } = useAppState();
  const submit = useSubmit();
  const [equipmentType, setEquipmentType] = useState<string>('ROBOT');
  const [facilityId, setFacilityId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [name, setName] = useState('');
  const [externalId, setExternalId] = useState('');
  const [sourceFilePath, setSourceFilePath] = useState('');
  const [interval, setInterval] = useState('');
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  // 設備は登録できたが、接続の保存に失敗したときの、登録した設備の ID（やり直しでは、設備を登録し直さず、修正する）
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const [partialMessage, setPartialMessage] = useState<string | undefined>(undefined);
  const errors = { ...clientErrors, ...submit.fieldErrors };
  const kind = equipmentType === 'SENSOR' ? 'SENSOR' : 'ROBOT';
  const { controller, copyCandidates } = useConnectionOf(kind, undefined, props.connection);

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setPartialMessage(undefined);
    const parsed = EquipmentCreateRequestSchema.safeParse({
      equipmentId,
      equipmentType,
      name,
      ...(facilityId === '' ? {} : { facilityId }),
      ...(externalId.trim() === '' ? {} : { externalId }),
      ...(sourceFilePath.trim() === '' ? {} : { sourceFilePath: sourceFilePath.trim() }),
      ...(interval === '' ? {} : { intervalMinutes: Number(interval) }),
    });
    // 設備と接続の入力を、両方検証して、項目ごとにエラーを示す
    const prepared = controller.prepare();
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    if (!prepared.ok) {
      setClientErrors({});
      return;
    }
    setClientErrors({});
    const result = await submit.run(() =>
      createdId === undefined
        ? createEquipment(api, parsed.data)
        : // 接続の保存に失敗したあとのやり直しは、登録済みの設備を修正する（設備ID・種別は、変更できない）
          updateEquipment(api, createdId, EquipmentUpdateRequestSchema.parse(parsed.data)),
    );
    if (!result.ok) {
      return;
    }
    const savedId = createdId ?? parsed.data.equipmentId;
    setCreatedId(savedId);
    reloadEquipment();
    if (prepared.connection !== undefined) {
      const saved = await controller.commit(savedId, prepared.connection);
      if (!saved) {
        setPartialMessage(TEXT.createdConnectionFailed);
        return;
      }
    }
    setEquipmentId('');
    setName('');
    setExternalId('');
    setSourceFilePath('');
    setInterval('');
    props.onDone(TEXT.created, 'dataEntry');
  }

  const busy = submit.busy || controller.busy;
  return (
    <form
      className="inline-form"
      noValidate
      aria-label={TEXT.addChild}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <p className="field-note muted" data-testid="equipment-id-rule">
        {TEXT.idRule}
      </p>
      <div className="form-grid">
        <Field label={TEXT.type} name="equipmentType" error={errors.equipmentType} required>
          {(control) => (
            <select
              {...control}
              value={equipmentType}
              disabled={createdId !== undefined}
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
              readOnly={createdId !== undefined}
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
        <Field
          label={TEXT.sourceFilePath}
          name="sourceFilePath"
          error={errors.sourceFilePath}
          hint={TEXT.sourceFilePathHint}
        >
          {(control) => (
            <input
              {...control}
              value={sourceFilePath}
              onChange={(event) => {
                setSourceFilePath(event.target.value);
              }}
            />
          )}
        </Field>
        <p className="field-note muted" data-testid="equipment-file-path-guide">
          {TEXT.sourceFilePathGuide}
        </p>
        <IntervalField value={interval} error={errors.intervalMinutes} onChange={setInterval} />
      </div>
      <ConnectionBlock
        context={props.connection}
        controller={controller}
        copyCandidates={copyCandidates}
        equipmentId={createdId}
      />
      {partialMessage === undefined ? null : (
        <p role="status" className="form-error" data-testid="equipment-partial">
          {partialMessage}
        </p>
      )}
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {TEXT.addSubmit}
        </button>
        <button type="button" className="button-secondary" onClick={props.onCancel}>
          {MESSAGES.form.cancel}
        </button>
      </div>
    </form>
  );
}

/** 設備の修正（名称・データ上の識別子・親のハウス）。設備IDと種別は変更できない。保存は、設備を保存してから、接続（変更があれば）を保存する。 */
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
  const [sourceFilePath, setSourceFilePath] = useState(equipment.sourceFilePath ?? '');
  const [interval, setInterval] = useState(
    equipment.intervalMinutes === undefined ? '' : String(equipment.intervalMinutes),
  );
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [partialMessage, setPartialMessage] = useState<string | undefined>(undefined);
  const errors = { ...clientErrors, ...submit.fieldErrors };
  const isFacility = equipment.equipmentType === 'FACILITY';
  const { controller, copyCandidates } = useConnectionOf(
    equipment.equipmentType,
    equipment.equipmentId,
    isFacility ? undefined : props.connection,
  );

  async function handleSubmit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setPartialMessage(undefined);
    const parsed = EquipmentUpdateRequestSchema.safeParse({
      name,
      ...(isFacility || facilityId === '' ? {} : { facilityId }),
      ...(externalId.trim() === '' ? {} : { externalId }),
      ...(isFacility || sourceFilePath.trim() === ''
        ? {}
        : { sourceFilePath: sourceFilePath.trim() }),
      ...(isFacility || interval === '' ? {} : { intervalMinutes: Number(interval) }),
    });
    // 設備と接続の入力を、両方検証して、項目ごとにエラーを示す
    const prepared = controller.prepare();
    if (!parsed.success) {
      setClientErrors(fieldErrorsOfZod(parsed.error));
      return;
    }
    if (!prepared.ok) {
      setClientErrors({});
      return;
    }
    setClientErrors({});
    const result = await submit.run(() => updateEquipment(api, equipment.equipmentId, parsed.data));
    if (!result.ok) {
      return;
    }
    reloadEquipment();
    if (prepared.connection !== undefined) {
      const saved = await controller.commit(equipment.equipmentId, prepared.connection);
      if (!saved) {
        setPartialMessage(TEXT.updatedConnectionFailed);
        return;
      }
    }
    props.onDone(TEXT.updated);
  }

  const busy = submit.busy || controller.busy;
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
        {isFacility ? null : (
          <>
            <Field
              label={TEXT.sourceFilePath}
              name="sourceFilePath"
              error={errors.sourceFilePath}
              hint={TEXT.sourceFilePathHint}
            >
              {(control) => (
                <input
                  {...control}
                  value={sourceFilePath}
                  onChange={(event) => {
                    setSourceFilePath(event.target.value);
                  }}
                />
              )}
            </Field>
            <p className="field-note muted" data-testid="equipment-file-path-guide">
              {TEXT.sourceFilePathGuide}
            </p>
          </>
        )}
        {isFacility ? null : (
          <IntervalField value={interval} error={errors.intervalMinutes} onChange={setInterval} />
        )}
      </div>
      {isFacility ? null : (
        <ConnectionBlock
          context={props.connection}
          controller={controller}
          copyCandidates={copyCandidates}
          equipmentId={equipment.equipmentId}
        />
      )}
      {partialMessage === undefined ? null : (
        <p role="status" className="form-error" data-testid="equipment-partial">
          {partialMessage}
        </p>
      )}
      <FormError message={submit.formMessage} />
      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {busy ? MESSAGES.form.saving : MESSAGES.form.save}
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
  // 閲覧の割り当て（ハウスごと）は、ユーザーを管理する権限がある利用者だけ（API も、その権限を要求する）
  const canAssign = usePermission('user:manage');
  const fetchAccess = useCallback(
    async () => (canAssign ? await getFacilityAccess(api) : undefined),
    [api, canAssign],
  );
  const access = usePolling(fetchAccess);
  const submit = useSubmit();
  const query = useQueryParams();
  const [assigning, setAssigning] = useState<Equipment | undefined>(undefined);
  const [editingChosen, setEditingChosen] = useState<Equipment | undefined>(undefined);
  // 登録のダイアログ（ハウス／ロボット・環境センサー）
  const [adding, setAdding] = useState<'facility' | 'child' | undefined>(undefined);
  const [deleting, setDeleting] = useState<Equipment | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [nextStep, setNextStep] = useState<NextStep | undefined>(undefined);
  // 取り込み設定・状況の画面から、設備の修正のダイアログを開くリンク（?edit=設備ID。取り込み元の接続を設定・修正する。Issue #367）
  const editParam = query.get('edit');
  const editing =
    editingChosen ??
    (canManage && editParam !== ''
      ? equipmentList.find((item) => item.equipmentId === editParam)
      : undefined);
  // 「取り込み元の接続」の欄は、取り込みの参照権限がある利用者だけ（設備ごとの接続は、取り込みの設定）
  const canReadIngestion = usePermission('ingestion:read');
  const canConfigureIngestion = usePermission('ingestion:configure');
  const canRunIngestion = usePermission('ingestion:run');
  const connectionDialogOpen = editing !== undefined || adding === 'child';
  const fetchIngestion = useCallback(
    async () =>
      canReadIngestion && connectionDialogOpen ? await getIngestionSettings(api) : undefined,
    [api, canReadIngestion, connectionDialogOpen],
  );
  const ingestion = usePolling(fetchIngestion, INGESTION_REFRESH_MS);
  const { reload: reloadIngestion } = ingestion;
  const connectionContext: ConnectionContext | undefined = canReadIngestion
    ? {
        sources: ingestion.data?.sources,
        loadFailed: ingestion.error !== undefined,
        canConfigure: canConfigureIngestion,
        canRun: canRunIngestion,
        reload: reloadIngestion,
      }
    : undefined;

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

  function closeEditing(): void {
    setEditingChosen(undefined);
    if (editParam !== '') {
      query.set({ edit: undefined });
    }
  }

  function done(message: string, next?: NextStep): void {
    closeEditing();
    setAdding(undefined);
    setNotice(message);
    setNextStep(next);
  }

  /** ハウスを閲覧できる一般ユーザーの表示（行の列）。 */
  function accessCell(equipment: Equipment): ReactNode {
    if (equipment.equipmentType !== 'FACILITY') {
      return MESSAGES.common.missingValue;
    }
    if (access.error !== undefined) {
      return <span className="muted">{TEXT.facilityAccess.loadFailed}</span>;
    }
    if (access.data === undefined) {
      return MESSAGES.common.missingValue;
    }
    const names = new Map(access.data.users.map((user) => [user.userId, user.userName]));
    const assigned = (
      access.data.facilities.find((item) => item.facilityId === equipment.equipmentId)?.userIds ??
      []
    ).flatMap((userId) => names.get(userId) ?? []);
    return assigned.length === 0 ? TEXT.facilityAccess.none : assigned.join('、');
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
        <td>{equipment.sourceFilePath ?? MESSAGES.common.missingValue}</td>
        <td>{intervalCell(equipment)}</td>
        {canAssign ? <td>{accessCell(equipment)}</td> : null}
        {canManage || canAssign ? (
          <td>
            <div className="row-actions">
              {canManage ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    setNotice(undefined);
                    setNextStep(undefined);
                    setEditingChosen(equipment);
                  }}
                >
                  {TEXT.edit}
                </button>
              ) : null}
              {canAssign && equipment.equipmentType === 'FACILITY' ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    setNotice(undefined);
                    setAssigning(equipment);
                  }}
                >
                  {TEXT.facilityAccess.assign}
                </button>
              ) : null}
              {canManage ? (
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
              ) : null}
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
              <th scope="col">{TEXT.sourceFilePath}</th>
              <th scope="col">{TEXT.interval}</th>
              {canAssign ? <th scope="col">{TEXT.facilityAccess.column}</th> : null}
              {canManage || canAssign ? <th scope="col">{TEXT.actions}</th> : null}
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
      {nextStep === 'registerChild' && canManage ? (
        <div className="notice notice-info" data-testid="equipment-next-step">
          <Icon name="info" size={18} />
          <p>{TEXT.nextAfterFacility}</p>
          <button
            type="button"
            data-testid="equipment-next-register-child"
            onClick={() => {
              setNotice(undefined);
              setNextStep(undefined);
              setAdding('child');
            }}
          >
            {TEXT.nextRegisterChild}
          </button>
        </div>
      ) : null}
      {nextStep === 'dataEntry' ? (
        <div className="notice notice-info" data-testid="equipment-next-step">
          <Icon name="info" size={18} />
          <p>{TEXT.nextAfterChild}</p>
          <Link to={PATHS.dataEntry} data-testid="equipment-next-data-entry">
            {TEXT.nextGoDataEntry}
          </Link>
        </div>
      ) : null}
      <FormError message={submit.formMessage} />
      <section className="panel" aria-label={TEXT.title}>
        {canManage ? (
          <div className="table-toolbar">
            <button
              type="button"
              onClick={() => {
                setNotice(undefined);
                setNextStep(undefined);
                setAdding('facility');
              }}
            >
              {TEXT.openAddFacility}
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice(undefined);
                setNextStep(undefined);
                setAdding('child');
              }}
            >
              {TEXT.openAddChild}
            </button>
          </div>
        ) : null}
        {body}
      </section>
      {canAssign && assigning !== undefined && access.data !== undefined ? (
        <Modal
          title={TEXT.facilityAccess.panelTitle(assigning.name)}
          size="wide"
          testId="facility-access-dialog"
          onClose={() => {
            setAssigning(undefined);
          }}
        >
          <FacilityAccessPanel
            key={assigning.equipmentId}
            facility={assigning}
            entry={access.data.facilities.find((item) => item.facilityId === assigning.equipmentId)}
            users={access.data.users}
            onSaved={(message) => {
              setAssigning(undefined);
              setNotice(message);
              access.reload();
            }}
            onCancel={() => {
              setAssigning(undefined);
            }}
          />
        </Modal>
      ) : null}
      {canManage && editing !== undefined ? (
        <Modal
          title={`${TEXT.typeLabels[editing.equipmentType]}（${editing.equipmentId}）を${TEXT.edit}`}
          testId="equipment-edit-dialog"
          onClose={closeEditing}
        >
          <EditForm
            key={editing.equipmentId}
            equipment={editing}
            facilities={facilities}
            connection={connectionContext}
            onDone={done}
            onCancel={closeEditing}
          />
        </Modal>
      ) : null}
      {canManage && adding !== undefined ? (
        <Modal
          title={adding === 'facility' ? TEXT.addFacility : TEXT.addChild}
          testId="equipment-add-dialog"
          onClose={() => {
            setAdding(undefined);
          }}
        >
          {adding === 'facility' ? (
            <FacilityForm
              onDone={done}
              onCancel={() => {
                setAdding(undefined);
              }}
            />
          ) : (
            <ChildForm
              facilities={facilities}
              connection={connectionContext}
              onDone={done}
              onCancel={() => {
                setAdding(undefined);
              }}
            />
          )}
        </Modal>
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

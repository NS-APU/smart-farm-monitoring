/**
 * 画面の文言（日本語）。コードに直書きせず、ここにまとめる（coding-standards.md「フロントエンド」）。
 * ステータス・観点・項目の名称は、共通コード（src/shared）の定義を使う。
 */

import { EVALUATION_INTERVAL_MINUTES } from '@smart-farm/shared/constants/evaluation-schedule';
import { MAX_LIST_PERIOD_DAYS } from '@smart-farm/shared/observation-list-period';
import { MANAGEMENT_MESSAGES } from './management-messages.ts';

export const MESSAGES = {
  ...MANAGEMENT_MESSAGES,
  appName: 'Greenhouse Monitor',
  common: {
    loading: '読み込み中…',
    retry: '再読み込み',
    notImplemented: 'この画面は、次の手順で実装します',
    networkError: 'サーバーに接続できませんでした。通信の状態を確認してください',
    unexpectedError: 'エラーが発生しました。しばらくしてからやり直してください',
    missingValue: '—',
    staleData:
      '最新の情報を取得できませんでした。表示は、前回取得した内容です（再接続を試みています）',
    newNotifications: (count: number) => `新しい通知が${String(count)}件あります`,
    renderFailed: '画面を表示できませんでした。ダッシュボードへ戻って、やり直してください',
    updated: '新しい版に更新されました。画面を再読み込みしてください',
    backToDashboard: 'ダッシュボードへ戻る',
  },
  login: {
    title: 'ログイン',
    userId: 'ユーザーID',
    password: 'パスワード',
    submit: 'ログイン',
    submitting: 'ログイン中…',
    failed: 'ユーザーIDまたはパスワードが正しくありません',
    // システムの目的を 1 行で（goals.md「システムの目的」の表現に合わせる）。SC-01-5
    purpose: 'ロボットとハウスの状態をデータで見える化し、早めの対応を支えるシステムです',
    // セッションが切れて、ログイン画面へ戻されたときの理由。SC-01-1
    sessionExpired: 'セッションの有効期限が切れました。もう一度ログインしてください',
    // 忘れたときは、管理者が再設定する（ADR-0020）。連絡先の具体的な名前・メールアドレス・電話番号は、書かない。SC-01-2
    forgotPassword: 'パスワードを忘れたときは、管理者に連絡してください',
  },
  passwordInput: {
    // 名前に「パスワード」を含めない（欄のラベルでの検索が、欄とボタンの 2 件にならないように）。状態は aria-pressed で伝える
    toggle: '入力した文字を表示',
    capsLockOn: 'Caps Lock がオンです。大文字で入力されます',
  },
  changePassword: {
    title: 'パスワードの変更',
    lead: '現在のパスワードを入力して、新しいパスワードを決めます。変更すると、ほかの端末のログインは、解除されます',
    forcedNotice:
      '管理者が決めたパスワードは、一時のものです。新しいパスワードを決めてください。変更するまで、ほかの操作はできません',
    current: '現在のパスワード',
    next: '新しいパスワード',
    confirm: '新しいパスワード（確認）',
    policyHint: '8文字以上で、英大文字・英小文字・数字を含めてください',
    submit: 'パスワードを変更する',
    submitting: '変更中…',
    currentRequired: '現在のパスワードを入力してください',
    newRequired: '新しいパスワードを入力してください',
    confirmMismatch: '新しいパスワード（確認）が一致しません',
    sameAsCurrent: '新しいパスワードは、現在のパスワードと違うものにしてください',
    link: 'パスワードの変更',
  },
  profile: {
    title: 'ユーザー名の変更',
    lead: 'ログインしているご自身のユーザー名を変えます。ユーザーID・ロールは、変えられません。パスワードは、「パスワードの変更」から変えます',
    userId: 'ユーザーID',
    userName: 'ユーザー名',
    submit: 'ユーザー名を変更する',
    submitting: '変更中…',
    nameRequired: 'ユーザー名を入力してください',
    nameTooLong: 'ユーザー名は200文字以内で入力してください',
    saved: 'ユーザー名を変更しました',
    link: 'ユーザー名の変更',
  },
  layout: {
    skipToContent: '本文へ移動',
    menu: 'メニュー',
    /** ヘッダーの ☰（サイドメニューの開閉。状態は、aria-expanded で示す）。 */
    toggleMenu: 'メニューの開閉',
    closeMenu: 'メニューを閉じる',
    equipment: '対象の設備',
    unreadNotifications: '未読の通知',
    lastReceived: '最終のデータ取得',
    notReceived: '未取得',
    /** 手動のみの運用（自動取り込みが有効でない）のヘッダー。最終の手動入力の日時（Issue #202）。 */
    lastManualInput: '最終の手動入力',
    noManualInput: 'まだありません',
    stale: '古い',
    user: 'ログイン中のユーザー',
    /** ユーザーメニュー（ポップアップ）の名前。 */
    userMenu: 'ユーザー',
    logout: 'ログアウト',
  },
  /** ヘッダーのテーマのメニュー（Issue #352）。 */
  theme: {
    label: 'テーマ',
    system: 'システム',
    systemDefault: 'システム（既定）',
    light: 'ライト',
    dark: 'ダーク',
  },
  nav: {
    dashboard: 'ダッシュボード',
    dataEntry: 'データ入力',
    observations: '計測データ',
    settings: '設定',
    equipment: 'ハウス・設備',
    ingestion: '取り込み',
    statusCodes: 'ステータスコード',
    users: 'ユーザー',
    pushSettings: '通知の設定',
  },
  dashboard: {
    title: 'ダッシュボード',
    // 3 つの見出しは、見分けがつく名前にする（Issue #356）: 状態ごとの件数（タイル）／観点別の状態の一覧（表）／観点ごとの詳しい内容（カード）
    summary: '状態ごとの観点の数',
    statusTable: '観点別の状態',
    statusTableViewpoint: '観点',
    statusTableCurrent: '現在',
    statusTablePeriod: '期間の評価',
    /** 短期を持たない観点の「現在」（表）。 */
    noCurrent: '現在の評価はありません',
    /** 状態ごとの観点の数の見出し。「現在」と「期間」を、別々に示す（#591）。 */
    summaryCurrent: '現在（直近24時間）',
    summaryPeriod: '期間の評価',
    /** カードの区画の見出し。 */
    currentTitle: '現在（直近24時間）',
    periodTitle: '期間の評価',
    /** 区画の評価の時刻。 */
    cardEvaluatedAt: '評価',
    viewpointList: '観点ごとの診断と推奨アクション',
    summaryCountLabel: (statusLabel: string) => `${statusLabel}の観点の数`,
    /** ダッシュボードの対象（ハウス単位）。ヘッダーの「対象の設備」から移した（Issue #355）。 */
    targetFacility: '対象のハウス',
    /** ダッシュボードの期間の欄の名前（視点〔短期・長期〕は、ない）。 */
    periodShort: '期間',
    refresh: '更新',
    refreshing: '更新中…',
    horizon: '視点',
    horizonShort: '短期',
    horizonLong: '長期',
    period: '期間',
    periodDays: { 1: '当日', 7: '直近7日', 30: '直近30日', 60: '直近60日', 90: '直近90日' },
    lastReceivedAt: '最終のデータ取得',
    freshnessStale: 'データが古くなっています。取り込みの状況を確認してください',
    freshnessManual:
      '自動取り込みが有効でないため、手動入力のデータで評価しています。「古い」「未取得」の警告は、出しません',
    /** 古い設備の名前（先頭の 3 つ。残りは「ほか N 件」）。全件は、開くと示す一覧（staleEquipmentList）に出す（Issue #158。ADR-0016 の D-12）。 */
    staleEquipment: (names: readonly string[], rest: number) =>
      `古い設備: ${names.map((name) => `「${name}」`).join('')}${rest > 0 ? `ほか ${String(rest)} 件` : ''}`,
    staleEquipmentList: (count: number) => `古い設備の一覧（${String(count)} 件）`,
    staleEquipmentName: '設備名',
    staleEquipmentLastReceived: '最終の受信日時',
    staleEquipmentThreshold: '基準（分）',
    staleEquipmentMinutes: (minutes: number) => `${String(minutes)} 分`,
    /** 評価が更新されていない警告（Issue #158。SC-02-6）。評価のジョブが止まると、古い状態が、現在のものに見えるため。 */
    evaluationStale: (evaluatedAt: string) =>
      `評価が更新されていません（最終の評価: ${evaluatedAt}）。評価の処理が止まっている可能性があり、表示のステータスは、現在の状態と違うことがあります`,
    /** 「最終の評価」の横のヘルプヒント（ADR-0014。手動入力の保存後の反映の遅れを含む）。 */
    evaluatedAtHintName: '最終の評価',
    evaluatedAtHint: (staleMinutes: number) =>
      `ステータスは、${String(EVALUATION_INTERVAL_MINUTES)} 分ごとの定期の評価で更新されます。手動入力を保存しても、ステータスへの反映に、最大 ${String(EVALUATION_INTERVAL_MINUTES)} 分かかることがあります。${String(staleMinutes)} 分以上更新されないときは、警告を出します`,
    /** 「最終のデータ取得」の横のヘルプヒント（Issue #158。SC-11-9。ADR-0016 の D-11・D-12）。 */
    lastReceivedHintName: '最終のデータ取得',
    lastReceivedHint: (refreshSeconds: number) =>
      `画面は、${String(refreshSeconds)} 秒ごとに更新されますが、新しいデータが増えるのは、設備ごとの取得間隔ごとです（取得間隔は、ハウス・設備の画面で設定します）。取り込み画面の「自動取り込みを有効にする」を外すと、手動のみの運用になり、「データが古い」の警告は出なくなります`,
    lastManualInputHintName: '最終の手動入力',
    lastManualInputHint:
      '自動取り込みが有効でない（手動のみの運用の）ときは、最終のデータ取得の代わりに、最後に手動入力した日時を示します。「データが古い」の警告は出ません。自動取り込みは、取り込み画面の「自動取り込みを有効にする」で、有効にできます',
    freshnessNone:
      'データがまだ取り込まれていません。データ入力または取り込み設定を確認してください',
    noEquipment: '設備が登録されていません。設備を登録してください',
    noViewableFacility: '閲覧できるハウスが割り当てられていません。管理者に連絡してください',
    recommendedAction: '推奨アクション',
    evaluatedPeriod: '判定の対象期間',
    customCriteria: 'カスタムの判断基準',
    notEvaluated: '評価がまだ行われていません',
    evaluatedAt: '最終の評価',
    goDataEntry: 'データ入力へ',
    goIngestion: '取り込みへ',
    shortWindow: '直近24時間',
  },
  /** ヘルプヒント（「?」）と、折りたたみ式の凡例（Issue #154）。 */
  help: {
    /** ヘルプヒントのボタンの名前（読み上げ）。対象の名前を含める。 */
    hintLabel: (name: string) => `${name}の説明`,
    example: '例',
    statusLegendTitle: '状態の見かた',
    statusCodeLegendTitle: 'カテゴリの見かた',
    /** ステータスコードのカテゴリの凡例の注記（ADR-0017 D-23。evaluation.md 3 章）。 */
    statusCodeLegendNote:
      'ステータスコードのカテゴリは、観点（収穫速度・メンテナンス性・耐久性）の判定にそのまま使われます。観点の状態は、指標の判定のうち最も悪いものです',
    qualityLegendTitle: 'データの状態の見かた',
    usedInEvaluation: '評価に使います',
    notUsedInEvaluation: '評価に使いません',
    qualityLegendNote: '評価に使える値が足りないときは、観点の状態が「不明」になります',
  },
  viewpoint: {
    breadcrumb: 'パンくず',
    backToDashboard: 'ダッシュボード',
    /** ダッシュボードから開く、観点の詳細の右からのドロワー（Issue #357）。 */
    drawer: {
      label: (viewpointName: string) => `${viewpointName}の詳細`,
      close: '観点の詳細を閉じる',
      openAsPage: 'ページで開く',
      /** 観点どうしの移動（ダッシュボードの観点の並びで、前後へ。SC-03-6）。 */
      navLabel: '観点の移動',
      previous: '前の観点',
      next: '次の観点',
    },
    /** 異常・注意の観点から、データ入力（UC-06）へ移るリンク（SC-02-10）。 */
    recordResponse: '対応の結果を記録する',
    equipment: '対象の設備',
    diagnosis: '診断結果',
    diagnosticMessage: '診断メッセージ',
    recommendedAction: '推奨アクション',
    /** 診断結果の 2 つの欄（FR-5.6。#591）。 */
    currentTitle: '現在',
    periodTitle: '期間の評価',
    noCurrent: '現在の評価はありません',
    /** 「現在の評価はありません」のヘルプヒント（ADR-0017 D-15。短期評価を持たない観点は、長い期間・一定期間の指標）。 */
    noCurrentHint: {
      name: '現在の評価',
      help: 'この観点は、長い期間・一定期間の指標のため、「現在」（直近24時間）の評価を持ちません。「期間の評価」を表示します',
    },
    notEvaluated: 'この観点は、まだ評価されていません。データの取り込み・入力後に表示されます',
    unknownGuide:
      'データ不足のため評価できません。次の画面で、データの取得・入力を確認してください',
    notApplicable: 'ハウスまたは対象の設備を選び直してください',
    /**
     * 評価しない設備を選んでいるときの案内（Issue #156）。観点の名称が分かるときは、名称を添える。
     * evaluatedBy: その観点を評価する設備の種類の表示名（ハウスを除く。ロボット・センサー）。空なら、ハウスだけで評価する。
     */
    notApplicableEvaluatedBy: (
      viewpointName: string | undefined,
      evaluatedBy: readonly string[],
      selectedTypeLabel: string,
    ) => {
      const subject = `この観点${viewpointName === undefined ? '' : `（${viewpointName}）`}`;
      const where =
        evaluatedBy.length === 0
          ? 'ハウスの評価です'
          : `${[...evaluatedBy, 'ハウス'].join('と')}で評価します`;
      return `${subject}は、${where}（${selectedTypeLabel}では評価しません）`;
    },
    /** 設備の種類の短い表示名（案内の文中用）。 */
    equipmentTypeShort: { FACILITY: 'ハウス', ROBOT: 'ロボット', SENSOR: 'センサー' },
    showFacility: (facilityName: string) => `ハウス「${facilityName}」を表示`,
    basis: '根拠の指標',
    metric: '指標',
    value: '値',
    judgement: '判定',
    primaryMark: '主要',
    statusRow: 'ステータス（名称）',
    noJudgement: '判定なし',
    criteria: '判断基準',
    criteriaIndicator: '指標',
    criteriaLabel: '条件名',
    criteriaChanged: '変更済み',
    criteriaDefault: '既定値',
    criteriaStatusNote:
      'ステータスコードのカテゴリ（正常・注意・異常）でも判定します。設定は、メニューの「ステータスコード」で行います',
    editCriteria: '判断基準を編集',
    statusCodeSettings: 'ステータスコード',
    trend: '推移',
    trendPeriod: '推移の期間',
    trendAverage: '期間の平均値',
    trendNoData: 'この期間のデータがありません',
    trendTableCaption: (metricLabel: string) => `${metricLabel}の推移（数値）`,
    trendTableTime: '日時',
    trendTableStatus: '状態',
    trendValues: '値の表',
    chartReadoutHint: '点を選ぶと、日時・値・状態を表示します（キーボードは、矢印キー）',
    chartReadoutTime: '日時',
    chartReadoutValue: '値',
    chartReadoutStatus: '状態',
    chartPointLabel: (time: string, value: string) => `${time}: ${value}`,
    trendHourly: '1時間ごと',
    trendDaily: '日ごと',
    chartLegend: '背景の色は、判断基準の区分（正常・注意・異常）を示します',
    /** 推移のグラフの背景の帯の説明（ADR-0017 D-24）。 */
    chartBandNote: '背景の帯は、現在の基準です（過去の評価は、当時の基準のままです）',
    /** ステータスの推移の説明（ADR-0017 D-25）。 */
    statusHistoryNote: '最終ステータス（短期と長期の悪いほう）の履歴です。期間を変えても、同じです',
    statusHistory: 'ステータスの推移',
    statusHistoryNone: 'この期間に記録されたステータスの変化はありません',
    statusHistoryInitial: '期間の開始時点',
    sourceData: '元データ',
    sourceDataLead: '診断に使った取り込みデータ・手動入力データです',
    keyword: 'キーワード',
    keywordPlaceholder: '項目・設備・値など',
    sort: '並べ替え',
    sortObservedAt: '計測日時',
    sortValue: '値',
    sortCategory: 'カテゴリ',
    sourceDataEmpty: '該当するデータがありません',
    sourceDataPeriodNote: `並べ替え・検索の対象は、診断期間のうち、終了日時から ${String(MAX_LIST_PERIOD_DAYS)} 日分です`,
    sourceDataPeriodGuidance: '診断（評価）がまだないため、並べ替え・キーワード検索は使えません',
    previousPage: '前へ',
    nextPage: '次へ',
    observedAt: '計測日時',
    item: '項目',
    source: '取得元',
    quality: '状態',
    toObservations: '計測データ一覧へ',
  },
  satisfaction: {
    title: '満足度の詳細',
    overall: '総合満足度',
    overallNote: '満足度以外の9観点の平均（小数第1位）',
    radar: '観点別の満足度（レーダーチャート）',
    scale: '1〜5スター',
    criteria: '判断基準',
    missingTitle: '未入力の観点があります',
    missingLead:
      '評価は「不明」です。新しい入力は、9観点すべてが必須です。以前の、一部の観点だけの入力が残っている（期間内の最新の入力に、値のない観点がある）ため、以前の入力を修正して、または新しく、9観点すべてを入力してください',
    noInputTitle: '期間内に、満足度の入力がありません',
    noInputLead:
      '評価は「不明」です。満足度は、入力者ごとの、期間内の最新の入力で評価します。月に 1 回を目安に、9観点すべてを入力してください。入力が遅れると、前回の入力が期間から外れて「不明」になります（期間を長くすると、前回の入力が含まれることがあります）',
    notEntered: '未入力',
    scores: '観点ごとの満足度',
    goDataEntry: 'データ入力へ',
  },
  placeholder: {
    screen: '画面',
  },
  notFound: {
    title: 'ページが見つかりません',
    hint: 'URL が違っているか、ページが移動した可能性があります。',
    back: 'ダッシュボードへ戻る',
  },
} as const;

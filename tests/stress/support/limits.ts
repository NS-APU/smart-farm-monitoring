/**
 * 負荷テストの許容時間（秒）。この1か所だけで管理する。テストは、操作の応答時間・次の操作が可能になるまでの時間の
 * どちらかが許容時間を超えたら、失敗する（記録は、失敗しても必ず結果ログに出す）。NFR の値は、緩めない。
 *
 * 実行環境による揺れ: GitHub のランナー（CI）は、CPU の速さが実行のたびに違う（同時 10 人の保存が、速いときは約 2 秒、
 * 遅いときは約 3.5 秒）。そのため、環境変数 STRESS_LIMIT_FACTOR（1 以上 3 以下。既定 1 = NFR の値のまま）で、
 * 許容時間に倍率をかけられる。CI の stress ジョブだけ 1.5 を指定する（.github/workflows/ci.yml）。手元の既定は、NFR のまま。
 * 倍率は、結果ログに記録する（report-log.ts）。
 *
 * 根拠: docs/10_design/requirements/non-functional-requirements.md
 * - NFR-3.4: ダッシュボードの初期表示を、3秒以内（暫定。現行の採用値として扱う）
 * - NFR-3.5: 期間を指定した推移の表示（1か月分のデータ）を、10秒以内（暫定）
 * - NFR-3.3: 画面に表示するデータを、10秒程度の頻度で更新できること
 * NFR に明示のない操作は、最も近い NFR の基準に合わせた（stresstest.report.md の採用基準の表に、根拠を明記する）。
 */

export interface LimitDefinition {
  /** 許容時間（秒）。 */
  readonly seconds: number;
  /** 採用の根拠（結果ログ・レポートに記載する）。 */
  readonly basis: string;
}

export const LIMITS = {
  /** ダッシュボードの初期表示（ログイン後・直接開く・設備や視点・期間の切り替え）。 */
  dashboardInitial: {
    seconds: 3,
    basis: 'NFR-3.4 ダッシュボードの初期表示 3秒以内',
  },
  /** 推移の表示（期間を指定した推移。1か月分以上を含む）。 */
  trend: {
    seconds: 10,
    basis: 'NFR-3.5 期間を指定した推移の表示（1か月分）10秒以内',
  },
  /** 約10秒ごとの自動更新（データの再取得と再描画）。 */
  refresh: {
    seconds: 10,
    basis: 'NFR-3.3 画面のデータを10秒程度の頻度で更新（更新が間隔内に完了すること）',
  },
  /** 画面の表示（遷移・一覧・詳細・絞り込み・ページ送り）。NFR に明示がなく、画面の表示で最も近い NFR-3.4 に合わせる。 */
  screen: {
    seconds: 3,
    basis: 'NFR に明示なし。画面の表示に最も近い NFR-3.4（画面の初期表示 3秒以内）',
  },
  /** 保存・削除・登録などの操作（評価の更新を含む）。NFR に明示がなく、NFR-3.4 に合わせる。 */
  operation: {
    seconds: 3,
    basis: 'NFR に明示なし。画面操作の応答に最も近い NFR-3.4（3秒以内）',
  },
  /** 取り込み・ジョブの実行（即時取得・定期取り込み・連携・評価の定期実行）の結果が画面に表れるまで。 */
  job: {
    seconds: 10,
    basis:
      'NFR に明示なし。データの処理を伴う操作に最も近い NFR-3.5（10秒以内）。NFR-3.3 の更新間隔 10秒 とも整合',
  },
} as const satisfies Record<string, LimitDefinition>;

export type LimitKey = keyof typeof LIMITS;

/** 許容時間にかけられる倍率の範囲。1 未満は、NFR より厳しくなり、大きすぎると、判定が実質なくなるため、範囲を限る。 */
export const LIMIT_FACTOR_MIN = 1;
export const LIMIT_FACTOR_MAX = 3;

/**
 * 環境変数 STRESS_LIMIT_FACTOR の値を、倍率にする。指定がない・空のときは 1（NFR の値のまま）。
 * 範囲外・数値でない値は、黙って無視せず、エラーにする（意図しない判定にならないようにする）。
 */
export function parseLimitFactor(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 1;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < LIMIT_FACTOR_MIN || value > LIMIT_FACTOR_MAX) {
    throw new Error(
      `STRESS_LIMIT_FACTOR は、${String(LIMIT_FACTOR_MIN)} 以上 ${String(LIMIT_FACTOR_MAX)} 以下の数値で指定してください: ${raw}`,
    );
  }
  return value;
}

/** 今回の実行で使う倍率（環境変数 STRESS_LIMIT_FACTOR。既定 1）。 */
export const LIMIT_FACTOR = parseLimitFactor(process.env.STRESS_LIMIT_FACTOR);

/** 倍率をかけた許容時間。小数第 3 位に丸める（浮動小数点の誤差を避ける）。根拠の文言は、NFR のまま。 */
export function effectiveLimit(key: LimitKey, factor: number = LIMIT_FACTOR): LimitDefinition {
  return {
    seconds: Math.round(LIMITS[key].seconds * factor * 1000) / 1000,
    basis: LIMITS[key].basis,
  };
}

/** 同時接続の利用者数（NFR-3.1 利用者10名ほど）。 */
export const CONCURRENT_USERS = 10;

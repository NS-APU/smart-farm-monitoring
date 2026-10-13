/** 初期データの投入の種類。 */

/** 起動時（環境変数 SEED_MODE）に指定できる種類。NONE: 初期データのみ／DEMO: デモの設備・合成データ・評価も入れる。 */
export const SEED_MODES = ['NONE', 'DEMO'] as const;
export type SeedMode = (typeof SEED_MODES)[number];

/** 開発用のリセットで指定できる種類。EQUIPMENT: デモの設備のみ（観測値は、開発用 API で用意する）。 */
export const DEV_SEED_MODES = [...SEED_MODES, 'EQUIPMENT'] as const;
export type DevSeedMode = (typeof DEV_SEED_MODES)[number];

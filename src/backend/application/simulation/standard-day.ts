/**
 * 内蔵の標準シナリオ（`standard-day`）: 収穫ロボット・環境センサーの、一日（日本時間）の変化（Issue #375）。
 * ロボット: 06:00 に稼働を始め、06:30〜11:00 が収穫のピーク、11:00 に待機、午後は収穫の速さが下がり、夕方に待機して、夜は電源なし。
 * **1 台目だけ**、13:00 に収穫異常（異常）→ 13:10 に停止中（注意）→ 13:30 に復旧し、16:00 にバッテリー不足（注意）になる（異常の発生と回復で、通知・評価が
 * どう動くかを確かめるため。2 台目以降は、収穫を続ける）。
 * 環境センサー: 温度は、夜 14〜16℃ → 日中 30℃ 前後 → 13:20 前後に 36℃（環境適応性の異常の範囲。35℃ 以上）→ 夕方に下がる。
 * 湿度は、温度と逆に動く。照度は、日の出から日没まで（ピーク 3.8 万 lx）。CO2 は、日中に植物が吸って下がる。
 * 温度以外の値は、昼間は、環境適応性の判断基準（default-criteria.ts）の「正常」の範囲に収めている（高温だけが、評価を変える）。夜間は、照度が 0 のため、判断基準の範囲外になる（現行の基準の仕様）。
 * ステータスコードは、初期の登録値（データ辞書 7 章）。値は、合成データ（実際の機体・作物の値ではない。仮定）。JSON で書いた別のシナリオも、同じ形で使える（simulation.md）。
 */

export const STANDARD_DAY_SCENARIO = {
  name: 'standard-day',
  description:
    '標準の一日: 午前に収穫のピーク、13 時に 1 台目の異常と復旧、16 時にバッテリー不足、昼に温度が上がる（合成データ）',
  robot: [
    // 設備を限定しない時間帯（全台。一日を、隙間なく覆う）
    { from: '00:00', to: '06:00', status: 'STANDBY', activity: 'off', harvestPerHour: 0 },
    { from: '06:00', to: '06:30', status: 'RUNNING', activity: 'running', harvestPerHour: 0 },
    {
      from: '06:30',
      to: '11:00',
      status: 'HARVESTING',
      activity: 'harvesting',
      harvestPerHour: 600,
      secondsPerFruit: 42,
    },
    { from: '11:00', to: '11:30', status: 'STANDBY', activity: 'standby', harvestPerHour: 0 },
    {
      from: '11:30',
      to: '13:30',
      status: 'HARVESTING',
      activity: 'harvesting',
      harvestPerHour: 540,
      secondsPerFruit: 45,
    },
    {
      from: '13:30',
      to: '16:00',
      status: 'HARVESTING',
      activity: 'harvesting',
      harvestPerHour: 480,
      secondsPerFruit: 52,
    },
    {
      from: '16:00',
      to: '17:30',
      status: 'HARVESTING',
      activity: 'harvesting',
      harvestPerHour: 440,
      secondsPerFruit: 58,
    },
    { from: '17:30', to: '18:00', status: 'STANDBY', activity: 'standby', harvestPerHour: 0 },
    { from: '18:00', to: '24:00', status: 'STANDBY', activity: 'off', harvestPerHour: 0 },
    // 1 台目だけ（異常の発生と回復・バッテリー不足）
    {
      from: '13:00',
      to: '13:10',
      status: 'HARVEST_ERROR',
      activity: 'stopped',
      harvestPerHour: 0,
      equipment: [1],
    },
    {
      from: '13:10',
      to: '13:30',
      status: 'STOPPED',
      activity: 'stopped',
      harvestPerHour: 0,
      equipment: [1],
    },
    {
      from: '16:00',
      to: '16:20',
      status: 'LOW_BATTERY',
      activity: 'standby',
      harvestPerHour: 0,
      equipment: [1],
    },
  ],
  sensor: {
    temperature: [
      { at: '00:00', value: 15 },
      { at: '05:00', value: 14 },
      { at: '07:00', value: 18 },
      { at: '09:00', value: 22 },
      { at: '11:00', value: 27 },
      { at: '12:30', value: 30 },
      { at: '13:00', value: 33 },
      { at: '13:20', value: 36.5 },
      { at: '14:00', value: 36 },
      { at: '15:00', value: 31 },
      { at: '16:00', value: 28.5 },
      { at: '18:00', value: 24 },
      { at: '21:00', value: 19 },
      { at: '24:00', value: 16 },
    ],
    humidity: [
      { at: '00:00', value: 78 },
      { at: '05:00', value: 80 },
      { at: '07:00', value: 75 },
      { at: '11:00', value: 62 },
      { at: '13:30', value: 50 },
      { at: '16:00', value: 58 },
      { at: '18:00', value: 66 },
      { at: '24:00', value: 76 },
    ],
    illuminance: [
      { at: '00:00', value: 0 },
      { at: '05:30', value: 0 },
      { at: '06:30', value: 5000 },
      { at: '09:00', value: 25_000 },
      { at: '12:00', value: 38_000 },
      { at: '15:00', value: 30_000 },
      { at: '17:30', value: 6000 },
      { at: '18:30', value: 0 },
      { at: '24:00', value: 0 },
    ],
    co2: [
      { at: '00:00', value: 950 },
      { at: '05:30', value: 990 },
      { at: '07:00', value: 900 },
      { at: '10:00', value: 830 },
      { at: '14:00', value: 810 },
      { at: '17:00', value: 850 },
      { at: '19:00', value: 930 },
      { at: '24:00', value: 950 },
    ],
  },
} as const;

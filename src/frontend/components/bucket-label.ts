/** 推移のグラフの横軸の表示（日本時間）。1時間ごとは「12:00」、日ごとは「10/09」。 */

import type { SeriesResponse } from '@smart-farm/shared/schemas/evaluation';
import { TIME_ZONE_JST } from '@smart-farm/shared/time';

const HOUR_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE_JST,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DAY_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE_JST,
  month: '2-digit',
  day: '2-digit',
});

export function formatBucketLabel(iso: string, bucket: SeriesResponse['bucket']): string {
  const date = new Date(iso);
  return (bucket === 'HOUR' ? HOUR_FORMAT : DAY_FORMAT).format(date);
}

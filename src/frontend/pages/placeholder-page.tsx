/** 未実装の画面の雛形。画面ID（SC-xx）と名称を示す。次の手順で、ユースケースごとに実装する。 */

import type { ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';

export interface PlaceholderPageProps {
  /** 機能仕様書の画面ID（例: SC-05）。 */
  readonly screenId: string;
  readonly title: string;
}

export function PlaceholderPage(props: PlaceholderPageProps): ReactNode {
  return (
    <section className="placeholder-page">
      <h1>{props.title}</h1>
      <p>
        {MESSAGES.placeholder.screen}: {props.screenId}
      </p>
      <p>{MESSAGES.common.notImplemented}</p>
    </section>
  );
}

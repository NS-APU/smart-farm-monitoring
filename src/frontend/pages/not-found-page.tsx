/** 存在しないパスの表示。 */

import type { ReactNode } from 'react';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

export function NotFoundPage(): ReactNode {
  return (
    <section className="not-found-page">
      <h1>{MESSAGES.notFound.title}</h1>
      <Link to={PATHS.dashboard}>{MESSAGES.notFound.back}</Link>
    </section>
  );
}

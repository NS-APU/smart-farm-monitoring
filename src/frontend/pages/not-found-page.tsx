/** 存在しないパスの表示。 */

import type { ReactNode } from 'react';
import { HouseAndStrawberry } from '../components/illustration.tsx';
import { MESSAGES } from '../i18n/messages.ts';
import { PATHS } from '../router/paths.ts';
import { Link } from '../router/router.tsx';

export function NotFoundPage(): ReactNode {
  return (
    <section className="not-found-page">
      <HouseAndStrawberry width={140} />
      <h1>{MESSAGES.notFound.title}</h1>
      <p>{MESSAGES.notFound.hint}</p>
      <Link to={PATHS.dashboard}>{MESSAGES.notFound.back}</Link>
    </section>
  );
}

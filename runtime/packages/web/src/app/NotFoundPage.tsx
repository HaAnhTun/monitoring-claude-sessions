import { Link, useLocation, useNavigate } from 'react-router';

import { EmptyState } from '../components/EmptyState.tsx';
import { useT } from '../i18n/context.ts';
import { usePageChrome } from './usePageChrome.ts';

/** Stands in for the requested path while the sentence is translated; the path itself is inserted afterwards as text. */
const PATH_SLOT = '\uE000';

/** Unknown path (04-ui.md 3.4, review R-28): the requested path as text, a primary way back and a link to the sessions list. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const headingRef = usePageChrome(t('notFound.documentTitle'));
  const [before = '', after = ''] = t('notFound.body', { path: PATH_SLOT }).split(PATH_SLOT);
  return (
    <section className="page page--not-found">
      <EmptyState
        icon="search"
        title={t('notFound.title')}
        headingLevel={1}
        titleRef={headingRef}
        announce={false}
        primary={{
          label: t('notFound.openOverview'),
          onClick: () => {
            void navigate('/');
          },
        }}
        secondary={<Link to="/sessions">{t('notFound.openSessions')}</Link>}
      >
        <p>
          {before}
          <code className="mono">{pathname}</code>
          {after}
        </p>
      </EmptyState>
    </section>
  );
}

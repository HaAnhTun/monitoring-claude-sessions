import { Link, useLocation } from 'react-router';

import { usePageChrome } from './usePageChrome.ts';

/** Unknown path (04-ui.md 3.4): the requested path as text, links back to the two main views. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  const headingRef = usePageChrome('Not found');
  return (
    <section className="page page--not-found">
      <h1 ref={headingRef} tabIndex={-1}>
        Page not found
      </h1>
      <p>
        The monitor has no page at <code className="mono">{pathname}</code>.
      </p>
      <p>
        <Link to="/">Overview</Link> · <Link to="/sessions">Sessions</Link>
      </p>
    </section>
  );
}

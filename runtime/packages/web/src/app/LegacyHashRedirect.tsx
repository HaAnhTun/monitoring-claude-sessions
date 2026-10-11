import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { parseHash } from '../lib/prefs.ts';

/** `/sessions/<sid>?tab=transcript[&agent=<agent>]` for a legacy `#sid=<sid>[&agent=<agent>]` link; null for any other hash. */
function targetOf(pathname: string, hash: string): string | null {
  if (pathname !== '/') return null;
  const { sid, agent } = parseHash(hash);
  if (sid === '') return null;
  const params = new URLSearchParams({ tab: 'transcript' });
  if (agent !== '') params.set('agent', agent);
  return `/sessions/${encodeURIComponent(sid)}?${params.toString()}`;
}

/**
 * Old bookmarks and shared links look like `/#sid=<id>&agent=<id>` (04-ui.md 3.3, must-preserve #1). Runs before the routes
 * render: on the root path with a session in the hash it replaces the entry with the session page, and it checks again
 * whenever the hash of the page changes.
 */
export function LegacyHashRedirect(): null {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const target = targetOf(pathname, hash);
    if (target !== null) void navigate(target, { replace: true });
  }, [pathname, hash, navigate]);

  useEffect(() => {
    const onHashChange = (): void => {
      const target = targetOf(window.location.pathname, window.location.hash);
      if (target !== null) void navigate(target, { replace: true });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [navigate]);

  return null;
}

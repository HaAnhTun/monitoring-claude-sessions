import { Button } from '../components/Button.tsx';
import { useSidebarSessions } from '../data/hooks/useSessions.ts';
import { sidebarGroupOf } from '../lib/lifecycle-display.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { SidebarNav, type NavCounts } from './SidebarNav.tsx';
import { SidebarSessionList } from './SidebarSessionList.tsx';

export const SIDEBAR_BODY_ID = 'sidebar-body';

/**
 * Navigation and live sessions (04-ui.md 4.1). Two columns from 900 px; below that the body is a disclosure "Menu and sessions"
 * whose state is the `navOpen` preference.
 */
export function Sidebar() {
  const { prefs, setPref } = usePrefs();
  const open = prefs.navOpen ?? false;
  const sessions = useSidebarSessions(prefs.showAll ?? false);
  const counts: NavCounts | null =
    sessions.data === undefined
      ? null
      : { sessions: sessions.data.items.filter((s) => sidebarGroupOf(s.state.state) === 'active').length };

  return (
    <aside className="sidebar" aria-label="Navigation and live sessions" data-open={open}>
      <Button
        icon={open ? 'chevron-down' : 'chevron-right'}
        aria-expanded={open}
        aria-controls={SIDEBAR_BODY_ID}
        onClick={() => {
          setPref('navOpen', !open);
        }}
      >
        Menu and sessions
      </Button>
      <div id={SIDEBAR_BODY_ID} className="sidebar__body">
        <SidebarNav counts={counts} />
        <SidebarSessionList />
      </div>
    </aside>
  );
}

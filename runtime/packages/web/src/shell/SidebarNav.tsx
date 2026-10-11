import { NavLink } from 'react-router';

import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/icons.ts';

export interface NavCounts {
  /** Sessions that are active now. */
  sessions?: number | undefined;
  /** Work items that need attention. */
  tasks?: number | undefined;
  /** Open alerts. */
  settings?: number | undefined;
}

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  countKey?: keyof NavCounts;
  countLabel?: string;
  end?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/sessions', label: 'Sessions', icon: 'sessions', countKey: 'sessions', countLabel: 'active' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/tasks', label: 'Tasks', icon: 'tasks', countKey: 'tasks', countLabel: 'need attention' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics' },
  { to: '/settings', label: 'Settings', icon: 'settings', countKey: 'settings', countLabel: 'alerts' },
];

/** The six views (04-ui.md 4.4). `NavLink` sets `aria-current="page"` on the current one; a missing count shows nothing. */
export function SidebarNav({ counts }: { counts: NavCounts | null }) {
  return (
    <nav aria-label="Main" className="sidebar-nav">
      <ul className="plain">
        {ITEMS.map((item) => {
          const count = item.countKey === undefined ? undefined : counts?.[item.countKey];
          return (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end === true} className="sidebar-nav__link">
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {count === undefined ? null : (
                  <span className="sidebar-nav__count">
                    {count}
                    <span className="sr-only"> {item.countLabel}</span>
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

import { NavLink } from 'react-router';

import { usePageRegistry, navItems, type NavCountKey, type NavItem } from '../app/routes.tsx';
import { Icon } from '../components/Icon.tsx';
import { useInstance } from '../data/hooks/useInstance.ts';
import { useOverview } from '../data/hooks/useOverview.ts';
import { useT } from '../i18n/context.ts';
import type { TFunction } from '../i18n/types.ts';

/** The figure of each entry that has one; a figure the server did not send is absent, never zero. */
export type NavCounts = Partial<Record<NavCountKey, number>>;

/** Active sessions (the `sessions.active` metric of the overview) and open alerts; nothing until the overview is known. */
export function useNavCounts(): NavCounts {
  const overview = useOverview().data;
  if (overview === undefined) return {};
  const active = overview.metrics.find((metric) => metric.key === 'sessions.active')?.value;
  return {
    ...(active === null || active === undefined ? {} : { sessions: active }),
    settings: overview.alerts.open,
  };
}

interface CountView {
  text: string;
  tone: 'working' | 'alert';
}

/** The count of an entry with its unit ("3 active", "2 alerts"); never a bare number. Settings shows alerts only above zero. */
function countOf(key: NavCountKey | undefined, counts: NavCounts | null, t: TFunction): CountView | null {
  if (key === undefined) return null;
  const count = counts?.[key];
  if (count === undefined) return null;
  switch (key) {
    case 'sessions':
      return { text: t('nav.count.sessions', { count }), tone: 'working' };
    case 'settings':
      return count > 0 ? { text: t('nav.count.alerts', { count }), tone: 'alert' } : null;
  }
}

export interface SidebarNavProps {
  items: readonly NavItem[];
  counts: NavCounts | null;
  /** The rail: the label and the count move into a tooltip (the link keeps its full accessible name). */
  tooltips?: boolean;
}

/**
 * The pages of the navigation (ADR 0073 decision 3). `NavLink` sets `aria-current="page"` on the current one. The main entries come
 * first and the footer entries (Settings) after them, in a second list.
 */
export function SidebarNav({ items, counts, tooltips = false }: SidebarNavProps) {
  const t = useT();
  const groups = [items.filter((item) => item.group === 'main'), items.filter((item) => item.group === 'footer')];
  return (
    <nav aria-label={t('nav.label')} className="sidebar-nav">
      {groups.map((group, index) =>
        group.length === 0 ? null : (
          <ul key={index === 0 ? 'main' : 'footer'} className="plain sidebar-nav__list">
            {group.map((item) => {
              const label = t(item.titleKey);
              const count = countOf(item.countKey, counts, t);
              return (
                <li key={item.key}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    className="sidebar-nav__link"
                    title={tooltips ? (count === null ? label : `${label}: ${count.text}`) : undefined}
                  >
                    <Icon name={item.icon} size="menu" />
                    <span className="sidebar-nav__label">{label}</span>
                    {count === null ? null : (
                      <>
                        {' '}
                        <span className="sidebar-nav__count" data-tone={count.tone}>
                          {count.text}
                        </span>
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        ),
      )}
    </nav>
  );
}

/** The navigation of the running application: the entries come from the registry and the instance, the figures from the overview. */
export function ConnectedSidebarNav({ tooltips }: { tooltips: boolean }) {
  const registry = usePageRegistry();
  const instance = useInstance().data;
  const counts = useNavCounts();
  return (
    <SidebarNav
      items={navItems(registry, instance?.features ?? null, instance?.kind ?? null)}
      counts={counts}
      tooltips={tooltips}
    />
  );
}

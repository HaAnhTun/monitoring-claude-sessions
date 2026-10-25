// The settings page (ADR 0073 decision 2): five sections behind `?section=`, one shown at a time. Everything on it is read only
// (ADR 0031): it shows how the monitor runs and is set up, offers the commands that change things, and keeps the display
// preferences of this browser.
import { Link } from 'react-router';

import { usePageChrome } from '../../app/usePageChrome.ts';
import { Icon } from '../../components/Icon.tsx';
import type { IconName } from '../../components/icons.ts';
import { useUrlState } from '../../components/FilterBar.tsx';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { formatUrlState, SETTINGS_SECTIONS, settingsSpec, type SettingsUrlState } from '../../lib/url-state.ts';
import { AboutSection } from './AboutSection.tsx';
import { ConfigInspector } from './ConfigInspector.tsx';
import { DataRetention } from './DataRetention.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { PreferencesForm } from './PreferencesForm.tsx';

type Section = SettingsUrlState['section'];

interface SectionSpec {
  titleKey: MessageKey;
  icon: IconName;
  leadKey: MessageKey | null;
}

const SECTIONS = {
  health: { titleKey: 'settings.section.health', icon: 'activity', leadKey: null },
  config: { titleKey: 'settings.section.config', icon: 'file-text', leadKey: 'settings.config.lead' },
  preferences: { titleKey: 'settings.section.preferences', icon: 'settings', leadKey: 'settings.prefs.lead' },
  data: { titleKey: 'settings.section.data', icon: 'database', leadKey: 'settings.data.lead' },
  about: { titleKey: 'settings.section.about', icon: 'info', leadKey: 'settings.about.lead' },
} as const satisfies Record<Section, SectionSpec>;

/** The address of a section: the default one (Health) is the bare page. */
function sectionSearch(section: Section): string {
  const search = formatUrlState(settingsSpec, { section }).toString();
  return search === '' ? '' : `?${search}`;
}

function SectionBody({ section }: { section: Section }) {
  switch (section) {
    case 'health':
      return <HealthPanel />;
    case 'config':
      return <ConfigInspector />;
    case 'preferences':
      return <PreferencesForm />;
    case 'data':
      return <DataRetention />;
    case 'about':
      return <AboutSection />;
  }
}

export function SettingsPage() {
  const t = useT();
  const title = t('route.settings.title');
  const headingRef = usePageChrome(title);
  const [{ section }] = useUrlState(settingsSpec);
  const spec = SECTIONS[section];
  return (
    <section className="page settings">
      <header className="settings__header">
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="muted">{t('settings.lead')}</p>
      </header>
      <div className="settings__layout">
        <nav className="settings-nav" aria-label={t('settings.nav.label')}>
          <ul className="settings-nav__list">
            {SETTINGS_SECTIONS.map((key) => (
              <li key={key}>
                <Link
                  to={{ search: sectionSearch(key) }}
                  className="settings-nav__link"
                  aria-current={key === section ? 'page' : undefined}
                  data-section={key}
                >
                  <Icon name={SECTIONS[key].icon} />
                  <span>{t(SECTIONS[key].titleKey)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="settings__body" aria-labelledby="settings-section-title" data-section={section}>
          <h2 id="settings-section-title">{t(spec.titleKey)}</h2>
          {spec.leadKey === null ? null : <p className="muted settings__lead">{t(spec.leadKey)}</p>}
          <SectionBody section={section} />
        </section>
      </div>
    </section>
  );
}

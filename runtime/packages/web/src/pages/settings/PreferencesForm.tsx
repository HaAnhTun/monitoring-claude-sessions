// Display preferences (04-ui.md 4.4.7, ADR 0073 decision 6): the same theme, density and language as the user menu, and the
// transcript options the menu does not have. Every choice is applied at once and kept in this browser (`mcs.ui.v3`); nothing is
// sent anywhere. "Reset display preferences" forgets what this browser stored and touches nothing else.
import { ENTRY_KINDS, type EntryKind } from '@mcs/shared';
import { useId, type ReactNode } from 'react';

import { Button } from '../../components/Button.tsx';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useI18n } from '../../i18n/context.ts';
import { LOCALES, type LocalePreference, type MessageKey } from '../../i18n/types.ts';
import type { PrefsData } from '../../lib/prefs.ts';
import { languageName } from '../../shell/UserMenu.tsx';
import { useAnnounce } from '../../state/announcer.tsx';
import { resolveDisplay, usePrefs, usePrefsStore } from '../../state/prefs-store.ts';
import { SettingsCard } from './SettingsParts.tsx';

type Theme = PrefsData['theme'];
type Density = PrefsData['density'];

const THEMES = [
  { value: 'auto', labelKey: 'menu.theme.auto' },
  { value: 'light', labelKey: 'menu.theme.light' },
  { value: 'dark', labelKey: 'menu.theme.dark' },
] as const satisfies readonly { value: Theme; labelKey: MessageKey }[];

const DENSITIES = [
  { value: 'comfortable', labelKey: 'menu.density.comfortable' },
  { value: 'compact', labelKey: 'menu.density.compact' },
] as const satisfies readonly { value: Density; labelKey: MessageKey }[];

const KIND_LABELS = {
  prompt: 'transcript.toolbar.kind.prompt',
  say: 'transcript.toolbar.kind.say',
  think: 'transcript.toolbar.kind.think',
  tool: 'transcript.toolbar.kind.tool',
  result: 'transcript.toolbar.kind.result',
} as const satisfies Record<EntryKind, MessageKey>;

/** What a transcript shows before a person chooses (the defaults of `TranscriptViewer`): thinking is off. */
const DEFAULT_KINDS: Readonly<Record<EntryKind, boolean>> = {
  prompt: true,
  say: true,
  think: false,
  tool: true,
  result: true,
};

/** A transcript opens with the newest entry first until a person chooses otherwise. */
const DEFAULT_NEWEST_FIRST = true;

interface ChoiceProps {
  name: string;
  value: string;
  checked: boolean;
  onChoose: () => void;
  children: ReactNode;
}

function Choice({ name, value, checked, onChoose, children }: ChoiceProps) {
  return (
    <label className="settings-choice">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChoose} />
      <span>{children}</span>
    </label>
  );
}

export function PreferencesForm() {
  const { t, preference, setLocale } = useI18n();
  const { prefs, setPref } = usePrefs();
  const store = usePrefsStore();
  const announce = useAnnounce();
  const groupId = useId();
  const { theme, density } = resolveDisplay(prefs, useInstance().data?.ui);
  const newestFirst = prefs.newestFirst ?? DEFAULT_NEWEST_FIRST;
  const kinds = { ...DEFAULT_KINDS, ...prefs.kinds };

  const languages: readonly { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: t('lang.auto') },
    ...LOCALES.map((code) => ({ value: code, label: languageName(code, t(code === 'en' ? 'lang.en' : 'lang.vi')) })),
  ];

  return (
    <div className="settings-prefs">
      {store.persistent ? null : <p className="settings-notice">{t('settings.prefs.memoryOnly')}</p>}
      <div className="settings-grid">
        <SettingsCard title={t('settings.prefs.appearance')}>
          <fieldset className="settings-fieldset">
            <legend>{t('menu.theme')}</legend>
            <div className="settings-choices">
              {THEMES.map((option) => (
                <Choice
                  key={option.value}
                  name={`${groupId}-theme`}
                  value={option.value}
                  checked={theme === option.value}
                  onChoose={() => {
                    setPref('theme', option.value);
                    announce(t('menu.announce.theme', { value: t(option.labelKey) }));
                  }}
                >
                  {t(option.labelKey)}
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>{t('menu.density')}</legend>
            <div className="settings-choices">
              {DENSITIES.map((option) => (
                <Choice
                  key={option.value}
                  name={`${groupId}-density`}
                  value={option.value}
                  checked={density === option.value}
                  onChoose={() => {
                    setPref('density', option.value);
                    announce(t('menu.announce.density', { value: t(option.labelKey) }));
                  }}
                >
                  {t(option.labelKey)}
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="settings-fieldset">
            <legend>{t('menu.language')}</legend>
            <div className="settings-choices">
              {languages.map((option) => (
                <Choice
                  key={option.value}
                  name={`${groupId}-language`}
                  value={option.value}
                  checked={preference === option.value}
                  onChoose={() => {
                    setLocale(option.value);
                    announce(t('menu.announce.language', { value: option.label }));
                  }}
                >
                  {option.value === 'auto' ? option.label : <span lang={option.value}>{option.label}</span>}
                </Choice>
              ))}
            </div>
          </fieldset>
        </SettingsCard>
        <SettingsCard title={t('settings.prefs.transcript')}>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={newestFirst}
              onChange={(event) => {
                setPref('newestFirst', event.target.checked);
              }}
            />
            <span>
              {t('transcript.toolbar.newestFirst')}
              <span className="settings-check__hint muted small">{t('settings.prefs.newestFirstHint')}</span>
            </span>
          </label>
          <fieldset className="settings-fieldset">
            <legend>{t('settings.prefs.kinds')}</legend>
            <p className="muted small">{t('settings.prefs.kindsHint')}</p>
            <div className="settings-choices">
              {ENTRY_KINDS.map((kind) => (
                <label key={kind} className="settings-check">
                  <input
                    type="checkbox"
                    checked={kinds[kind]}
                    onChange={(event) => {
                      setPref('kinds', { ...kinds, [kind]: event.target.checked });
                    }}
                  />
                  <span>{t(KIND_LABELS[kind])}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </SettingsCard>
      </div>
      <div className="settings-reset">
        <Button
          icon="refresh"
          onClick={() => {
            // The remembered instance id is not a display preference: forgetting it would show a false "instance changed" notice.
            store.resetPrefs(['lastInstanceId']);
            announce(t('settings.prefs.resetDone'), { force: true });
          }}
        >
          {t('settings.prefs.reset')}
        </Button>
        <p className="muted small">{t('settings.prefs.resetHint')}</p>
      </div>
    </div>
  );
}

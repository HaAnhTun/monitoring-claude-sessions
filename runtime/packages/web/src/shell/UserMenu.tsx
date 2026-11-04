import { Menu, MenuGroup, MenuItem, MenuRadio, MenuSeparator } from '../components/Menu.tsx';
import type { IconName } from '../components/icons.ts';
import { useInstance } from '../data/hooks/useInstance.ts';
import { useI18n } from '../i18n/context.ts';
import { LOCALES, type Locale, type LocalePreference, type MessageKey } from '../i18n/types.ts';
import type { PrefsData } from '../lib/prefs.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { resolveDisplay, usePrefs } from '../state/prefs-store.ts';
import { useShortcutRegistry } from '../state/shortcuts-registry.tsx';

type Theme = PrefsData['theme'];
type Density = PrefsData['density'];

const THEMES = [
  { value: 'auto', icon: 'theme-auto', labelKey: 'menu.theme.auto' },
  { value: 'light', icon: 'sun', labelKey: 'menu.theme.light' },
  { value: 'dark', icon: 'moon', labelKey: 'menu.theme.dark' },
] as const satisfies readonly { value: Theme; icon: IconName; labelKey: MessageKey }[];

const DENSITIES = [
  { value: 'comfortable', labelKey: 'menu.density.comfortable' },
  { value: 'compact', labelKey: 'menu.density.compact' },
] as const satisfies readonly { value: Density; labelKey: MessageKey }[];

/**
 * The name of a language in that language ("English", the Vietnamese name in Vietnamese), so a reader who cannot read the current
 * language still finds theirs. The browser knows the names; the catalogue name is the fallback of a browser that does not.
 */
export function languageName(code: Locale, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name !== undefined && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // Fall back to the catalogue.
  }
  return fallback;
}

/**
 * The one menu of the top bar (ADR 0073 decision 6): Theme (automatic, light, dark), Density (comfortable, compact), Language and
 * the keyboard shortcuts. A choice is applied at once, announced politely and leaves the menu open; the shortcuts item closes it
 * and opens the dialog. The preferences are the ones of `usePrefs`; the language goes through the i18n provider, which also sets
 * `<html lang>`.
 */
export function UserMenu() {
  const { t, preference, setLocale } = useI18n();
  const { prefs, setPref } = usePrefs();
  const announce = useAnnounce();
  const { setHelpOpen } = useShortcutRegistry();
  const { theme, density } = resolveDisplay(prefs, useInstance().data?.ui);

  const languages: readonly { value: LocalePreference; label: string }[] = [
    { value: 'auto', label: t('lang.auto') },
    ...LOCALES.map((code) => ({ value: code, label: languageName(code, t(code === 'en' ? 'lang.en' : 'lang.vi')) })),
  ];

  return (
    <Menu label={t('menu.trigger')} icon="user">
      <MenuGroup label={t('menu.theme')}>
        {THEMES.map((option) => (
          <MenuRadio
            key={option.value}
            icon={option.icon}
            checked={theme === option.value}
            onSelect={() => {
              setPref('theme', option.value);
              announce(t('menu.announce.theme', { value: t(option.labelKey) }));
            }}
          >
            {t(option.labelKey)}
          </MenuRadio>
        ))}
      </MenuGroup>
      <MenuGroup label={t('menu.density')}>
        {DENSITIES.map((option) => (
          <MenuRadio
            key={option.value}
            checked={density === option.value}
            onSelect={() => {
              setPref('density', option.value);
              announce(t('menu.announce.density', { value: t(option.labelKey) }));
            }}
          >
            {t(option.labelKey)}
          </MenuRadio>
        ))}
      </MenuGroup>
      <MenuGroup label={t('menu.language')}>
        {languages.map((option) => (
          <MenuRadio
            key={option.value}
            checked={preference === option.value}
            onSelect={() => {
              setLocale(option.value);
              announce(t('menu.announce.language', { value: option.label }));
            }}
          >
            {option.value === 'auto' ? option.label : <span lang={option.value}>{option.label}</span>}
          </MenuRadio>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        icon="keyboard"
        onSelect={() => {
          setHelpOpen(true);
        }}
      >
        {t('menu.shortcuts')}
      </MenuItem>
    </Menu>
  );
}

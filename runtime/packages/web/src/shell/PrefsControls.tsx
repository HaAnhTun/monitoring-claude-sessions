import { Button } from '../components/Button.tsx';
import type { IconName } from '../components/icons.ts';
import { useInstance } from '../data/hooks/useInstance.ts';
import type { PrefsData } from '../lib/prefs.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { resolveDisplay, usePrefs } from '../state/prefs-store.ts';
import { useShortcutRegistry } from '../state/shortcuts-registry.tsx';

const THEME_CYCLE: readonly PrefsData['theme'][] = ['auto', 'light', 'dark'];
const THEME_ICON: Record<PrefsData['theme'], IconName> = { auto: 'theme-auto', light: 'sun', dark: 'moon' };

/** Theme cycle (auto, light, dark), density toggle and the shortcuts button (04-ui.md 4.4). Changes are announced. */
export function PrefsControls() {
  const { prefs, setPref } = usePrefs();
  const announce = useAnnounce();
  const { setHelpOpen } = useShortcutRegistry();
  const { theme, density } = resolveDisplay(prefs, useInstance().data?.ui);

  function cycleTheme(): void {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? 'auto';
    setPref('theme', next);
    announce(`Theme: ${next}`);
  }

  function toggleDensity(): void {
    const next = density === 'compact' ? 'comfortable' : 'compact';
    setPref('density', next);
    announce(`Density: ${next}`);
  }

  return (
    <div className="prefs-controls btn-group">
      <Button icon={THEME_ICON[theme]} onClick={cycleTheme}>
        {`Theme: ${theme}`}
      </Button>
      <Button icon="density" onClick={toggleDensity}>
        {`Density: ${density}`}
      </Button>
      <Button
        icon="keyboard"
        onClick={() => {
          setHelpOpen(true);
        }}
      >
        Shortcuts
      </Button>
    </div>
  );
}

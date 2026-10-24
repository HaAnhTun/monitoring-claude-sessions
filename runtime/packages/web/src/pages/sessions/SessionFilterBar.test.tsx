import { LIFECYCLE_STATES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import { parseUrlState, sessionsSpec } from '../../lib/url-state.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { SessionFilterBar } from './SessionFilterBar.tsx';

function renderBar(locale: 'en' | 'vi') {
  const state = parseUrlState(sessionsSpec(24), new URLSearchParams()).value;
  return renderWithIntl(
    <ShortcutRegistryProvider>
      <SessionFilterBar
        state={state}
        onChange={() => undefined}
        ignoredKeys={[]}
        onDismissIgnored={() => undefined}
        activeCount={0}
        onClearAll={() => undefined}
      />
    </ShortcutRegistryProvider>,
    { locale },
  );
}

function stateOptionTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.filter-bar__field--multi .filter-bar__check span')].map(
    (el) => el.textContent,
  );
}

describe('SessionFilterBar', () => {
  it('offers every lifecycle state under its catalogue word', () => {
    const { container } = renderBar('en');
    expect(stateOptionTexts(container)).toEqual(LIFECYCLE_STATES.map((state) => msg(lifecycleDisplay(state).labelKey)));
  });

  it('offers the states in Vietnamese when the language is Vietnamese', () => {
    const { container } = renderBar('vi');
    expect(stateOptionTexts(container)).toEqual(
      LIFECYCLE_STATES.map((state) => msg(lifecycleDisplay(state).labelKey, undefined, 'vi')),
    );
  });
});

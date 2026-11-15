import { useEffect, useRef } from 'react';

import { Button } from '../components/Button.tsx';
import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { SHORTCUT_GROUPS, SHORTCUT_HELP, type KeyCapName, type ShortcutGroup } from '../lib/shortcuts.ts';
import { useShortcutRegistry } from '../state/shortcuts-registry.tsx';

const GROUP_KEYS = {
  navigation: 'shortcuts.group.navigation',
  search: 'shortcuts.group.search',
  transcript: 'shortcuts.group.transcript',
  terminal: 'shortcuts.group.terminal',
} as const satisfies Record<ShortcutGroup, MessageKey>;

const CAP_KEYS = {
  esc: 'shortcuts.key.esc',
  up: 'shortcuts.key.up',
  down: 'shortcuts.key.down',
  home: 'shortcuts.key.home',
  end: 'shortcuts.key.end',
} as const satisfies Record<KeyCapName, MessageKey>;

/** One row: the key caps to press and what they do. Several caps are alternatives, not a chord. */
interface Row {
  id: string;
  caps: readonly string[];
  description: string;
  group: ShortcutGroup;
}

/**
 * The shortcuts in a native `<dialog>` (04-ui.md 6.5, 6.6 rule 9), grouped as Navigation, Search, Transcript and Terminal, one key
 * cap (`kbd`) per key. A shortcut that a mounted component registered is listed with the words that component gave it, so `f`, `[`
 * and `]` appear only while a transcript is open and `t` only on the Workspace; the fixed rows (Esc and the arrow keys of the
 * session list, and the keys of the terminal: the way out of it, copy, paste and scrolling) are always there, so the way out of
 * the keyboard trap is documented before anyone needs it.
 * Esc closes the dialog natively, so does a click on the backdrop.
 */
export function ShortcutsDialog() {
  const t = useT();
  const { shortcuts, helpOpen, setHelpOpen } = useShortcutRegistry();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<Element | null>(null);

  // A click on the backdrop lands on the dialog element itself; a click on its content does not. The dialog is not a control, so
  // the listener is native (Esc, the keyboard way to close it, is handled by the browser).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.target === dialog) setHelpOpen(false);
    };
    dialog.addEventListener('click', onClick);
    return () => {
      dialog.removeEventListener('click', onClick);
    };
  }, [setHelpOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (helpOpen && !dialog.open) {
      opener.current = document.activeElement;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!helpOpen && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [helpOpen]);

  const rows: Row[] = [
    ...shortcuts.map((shortcut) => ({
      id: `key:${shortcut.key}`,
      caps: [shortcut.key],
      description: shortcut.description,
      group: shortcut.group,
    })),
    ...SHORTCUT_HELP.filter((help) => help.fixed).map((help) => ({
      id: `fixed:${help.descriptionKey}`,
      caps: help.keys.map((key) => (typeof key === 'string' ? key : t(CAP_KEYS[key.cap]))),
      description: t(help.descriptionKey),
      group: help.group,
    })),
  ];

  return (
    <dialog
      ref={dialogRef}
      className="shortcuts-dialog"
      aria-labelledby="shortcuts-dialog-title"
      onClose={() => {
        setHelpOpen(false);
        // Browsers give the focus back to the element that opened a modal dialog; do it here too, for those that do not.
        const target = opener.current;
        opener.current = null;
        if (target instanceof HTMLElement && target.isConnected && document.activeElement !== target) target.focus();
      }}
    >
      <h2 id="shortcuts-dialog-title" className="shortcuts-dialog__title">
        {t('shortcuts.title')}
      </h2>
      {SHORTCUT_GROUPS.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        if (inGroup.length === 0) return null;
        const headingId = `shortcuts-group-${group}`;
        return (
          <section key={group} className="shortcuts-dialog__group" aria-labelledby={headingId}>
            <h3 id={headingId} className="shortcuts-dialog__heading">
              {t(GROUP_KEYS[group])}
            </h3>
            <dl className="shortcuts-dialog__list">
              {inGroup.map((row) => (
                <div key={row.id} className="shortcuts-dialog__row">
                  <dt className="shortcuts-dialog__keys">
                    {row.caps.map((cap) => (
                      <kbd key={cap} className="kbd">
                        {cap}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="shortcuts-dialog__description">{row.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      <div className="state__actions">
        <Button
          onClick={() => {
            setHelpOpen(false);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
    </dialog>
  );
}

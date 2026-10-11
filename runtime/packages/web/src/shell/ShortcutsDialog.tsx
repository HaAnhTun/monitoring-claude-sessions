import { useEffect, useRef } from 'react';

import { Button } from '../components/Button.tsx';
import { SHORTCUT_HELP } from '../lib/shortcuts.ts';
import { useShortcutRegistry } from '../state/shortcuts-registry.tsx';

/** Rows that no component registers: native keys and the local handler of the session list. */
const FIXED_ROWS = SHORTCUT_HELP.filter((row) => row.keys.length > 1);

/** The active shortcuts in a native `<dialog>` (04-ui.md 6.5, 6.6 rule 9). Esc closes it natively. */
export function ShortcutsDialog() {
  const { shortcuts, helpOpen, setHelpOpen } = useShortcutRegistry();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (helpOpen && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!helpOpen && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [helpOpen]);

  const rows = [...shortcuts.map((s) => ({ keys: s.key, description: s.description })), ...FIXED_ROWS];

  return (
    <dialog
      ref={dialogRef}
      className="shortcuts-dialog"
      aria-labelledby="shortcuts-dialog-title"
      onClose={() => {
        setHelpOpen(false);
      }}
    >
      <h2 id="shortcuts-dialog-title">Keyboard shortcuts</h2>
      <dl className="shortcuts-dialog__list">
        {rows.map((row) => (
          <div key={row.keys} className="shortcuts-dialog__row">
            <dt>
              <kbd>{row.keys}</kbd>
            </dt>
            <dd>{row.description}</dd>
          </div>
        ))}
      </dl>
      <div className="state__actions">
        <Button
          onClick={() => {
            setHelpOpen(false);
          }}
        >
          Close
        </Button>
      </div>
    </dialog>
  );
}

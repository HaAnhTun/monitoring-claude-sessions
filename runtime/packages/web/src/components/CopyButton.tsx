import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n/context.ts';
import { copyText, type ClipboardDeps } from '../lib/clipboard.ts';
import { useAnnounce } from '../state/announcer.tsx';

export interface CopyButtonProps {
  text: string | (() => string);
  /** Accessible name: "Copy tool input". */
  label: string;
  compact?: boolean;
  /** Visible content; the catalogue's "Copy" by default. */
  children?: ReactNode;
  /** The clipboard environment (tests); the browser's by default. */
  clipboard?: ClipboardDeps;
  /** Called with the outcome and the message that was announced. */
  onResult?: (ok: boolean, message: string) => void;
}

const CONFIRM_MS = 2000;

/**
 * Copies text with `lib/clipboard.copyText`: the async clipboard in a secure context, else the text area fallback. The
 * outcome is announced through the one live region of the page (`useAnnounce`, 04-ui.md 4.3 and 6.6 rule 6); outside the
 * provider the announcement is a no-op and only `onResult` and the visible state report it.
 */
export function CopyButton({ text, label, compact = false, children, clipboard, onResult }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const announce = useAnnounce();
  const t = useT();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function onClick(): Promise<void> {
    const value = typeof text === 'function' ? text() : text;
    const ok = await copyText(value, clipboard);
    const message = ok ? t('common.copied') : t('common.copyFailed');
    setStatus(ok ? 'copied' : 'failed');
    announce(message, { force: true });
    onResult?.(ok, message);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setStatus('idle');
    }, CONFIRM_MS);
  }

  const base = compact ? 'btn btn-quiet copy-btn copy-btn--compact' : 'btn btn-quiet copy-btn';
  const className = status === 'idle' ? base : `${base} is-${status}`;
  const visible = status === 'copied' && children === undefined ? t('common.copied') : (children ?? t('common.copy'));
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onClick={() => {
        void onClick();
      }}
    >
      {visible}
    </button>
  );
}

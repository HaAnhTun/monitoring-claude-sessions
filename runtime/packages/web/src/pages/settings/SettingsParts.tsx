// Small building blocks that the sections of the settings page share: a titled card, a list of facts and a command line with its
// Copy button. Layout and text only; every string reaches them as a prop from the catalogue.
import { useId, type ReactNode } from 'react';

import { CopyButton } from '../../components/CopyButton.tsx';
import { LiveDot } from '../../shell/HealthPopover.tsx';
import type { ChipTone } from '../../stream/freshness.ts';

export interface SettingsCardProps {
  title: string;
  /** The colour of the dot in front of the title. The words below it carry the meaning; no dot means no verdict. */
  tone?: ChipTone | undefined;
  /** The card spans the whole row of the grid (long lists). */
  wide?: boolean | undefined;
  /** A line under the title. */
  note?: ReactNode;
  children: ReactNode;
}

export function SettingsCard({ title, tone, wide = false, note, children }: SettingsCardProps) {
  const id = useId();
  return (
    <section className={wide ? 'card settings-card settings-card--wide' : 'card settings-card'} aria-labelledby={id}>
      <h3 id={id} className="settings-card__title">
        {tone === undefined ? null : <LiveDot tone={tone} />}
        <span>{title}</span>
      </h3>
      {note === undefined ? null : <p className="settings-card__note muted small">{note}</p>}
      {children}
    </section>
  );
}

/** A value that is a verdict: a dot and the word, never the dot alone. */
export function Verdict({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className="settings-verdict">
      <LiveDot tone={tone} />
      <span>{children}</span>
    </span>
  );
}

/** A value that is not there. */
export function Dash() {
  return <span className="muted">-</span>;
}

export function Facts({ children, columns = false }: { children: ReactNode; columns?: boolean }) {
  return <dl className={columns ? 'settings-facts settings-facts--cols' : 'settings-facts'}>{children}</dl>;
}

export interface FactProps {
  label: string;
  children: ReactNode;
  /** The value is a code, an id or a path: monospace, and it breaks anywhere instead of widening the page. */
  mono?: boolean;
}

export function Fact({ label, children, mono = false }: FactProps) {
  return (
    <div className="settings-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'settings-fact__value mono' : 'settings-fact__value'}>{children}</dd>
    </div>
  );
}

export interface CommandLineProps {
  /** The command exactly as the server sent it; the Copy button copies this string and nothing else. */
  command: string;
  /** Accessible name of the Copy button. */
  copyLabel: string;
}

export function CommandLine({ command, copyLabel }: CommandLineProps) {
  return (
    <div className="settings-command">
      <code className="settings-command__text">{command}</code>
      <CopyButton text={command} label={copyLabel} compact />
    </div>
  );
}

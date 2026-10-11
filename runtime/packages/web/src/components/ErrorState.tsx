import type { ReactNode } from 'react';

import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';

export type ErrorStateKind = 'load' | 'refresh' | 'not-found' | 'crash' | 'contract';

export interface ErrorStateProps {
  kind: ErrorStateKind;
  /** Any Error; an ApiError of the data layer extends it. */
  error?: Error | undefined;
  size?: 'page' | 'block' | 'inline';
  /** Shows the retry button ("Reload view" for a crash). */
  onRetry?: (() => void) | undefined;
  /** `refresh` kind: epoch milliseconds of the data still shown. */
  lastGoodAt?: number | null | undefined;
  /** What failed, as a plural noun ("sessions"); defaults to "data". */
  subject?: string | undefined;
  /** Extra actions (links, copy buttons) rendered after the retry button. */
  children?: ReactNode;
}

const NOT_FOUND_TEXT =
  'The monitor does not know this session. It may be outside the session window or belong to another task.';

function ageText(lastGoodAt: number | null | undefined): string {
  if (lastGoodAt === null || lastGoodAt === undefined) return 'earlier';
  const seconds = Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function messageFor({ kind, error, lastGoodAt, subject = 'data' }: ErrorStateProps): string {
  const detail = error?.message;
  switch (kind) {
    case 'load':
      return detail === undefined
        ? `Could not load ${subject}. Retrying automatically.`
        : `Could not load ${subject}: ${detail}. Retrying automatically.`;
    case 'refresh':
      return `${detail === undefined ? `Could not refresh ${subject}.` : `Could not refresh ${subject}: ${detail}.`} Showing data from ${ageText(lastGoodAt)}.`;
    case 'not-found':
      return NOT_FOUND_TEXT;
    case 'crash':
      return 'This view failed to render.';
    case 'contract':
      return detail === undefined
        ? `The monitor returned ${subject} this page cannot read.`
        : `The monitor returned ${subject} this page cannot read: ${detail}.`;
  }
}

export function ErrorState(props: ErrorStateProps) {
  const { kind, size = 'block', onRetry, children } = props;
  // role="alert" only for a page-size load failure (04-ui.md 4.3); everything else is a polite status.
  const role = kind === 'load' && size === 'page' ? 'alert' : 'status';
  return (
    <div className={`state state--error state--${size}`} role={role} data-kind={kind}>
      <p className="state__title">
        <Icon name="alert" />
        <span>{messageFor(props)}</span>
      </p>
      {onRetry === undefined && children === undefined ? null : (
        <div className="state__actions">
          {onRetry === undefined ? null : (
            <Button icon="refresh" onClick={onRetry}>
              {kind === 'crash' ? 'Reload view' : 'Retry now'}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

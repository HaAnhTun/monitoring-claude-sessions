import type { ReactNode } from 'react';

import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export type Tone =
  'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'unknown' | 'stale' | 'partial' | 'ok' | 'neutral';

export interface TagBadgeProps {
  tone: Tone;
  icon?: IconName | undefined;
  children: ReactNode;
  tip?: string | undefined;
  /** Extra class names, used by StateBadge for the size and nothing else. */
  extraClass?: string | undefined;
  state?: string | undefined;
}

/**
 * A tag, a source or a piece of metadata: muted 12 px text with an optional icon, no border and no pill (ADR 0071 decision 7).
 * The tones that ask for attention (failed, stale, partial, unknown, waiting) keep their colour; the word is always there, so
 * status is never colour-only (UI-I8). A state of a session is a `StateBadge`, not a tag.
 */
export function TagBadge({ tone, icon, children, tip, extraClass, state }: TagBadgeProps) {
  const className = `badge badge--tag tone-${tone}${extraClass === undefined ? '' : ` ${extraClass}`}`;
  return (
    <span className={className} title={tip} data-state={state}>
      {icon === undefined ? null : <Icon name={icon} />}
      <span>{children}</span>
    </span>
  );
}

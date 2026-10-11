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

/** A word (and optionally an icon) on a tone colour: status is never colour-only (UI-I8). */
export function TagBadge({ tone, icon, children, tip, extraClass, state }: TagBadgeProps) {
  const className = extraClass === undefined ? `badge tone-${tone}` : `badge tone-${tone} ${extraClass}`;
  return (
    <span className={className} title={tip} data-state={state}>
      {icon === undefined ? null : <Icon name={icon} />}
      <span>{children}</span>
    </span>
  );
}

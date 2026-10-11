import type { TokenUsage } from '@mcs/shared';

import { tokenLine, usageBadge } from '../lib/format.ts';
import { TagBadge } from './TagBadge.tsx';

export interface TokenLineProps {
  usage: TokenUsage | null;
}

/**
 * The legacy token line "out X · new input Y · cache read Z" with a completeness badge. A number the monitor does not have is
 * "n/a", never 0 (UI-I9); usage that is not available at all shows only the badge.
 */
export function TokenLine({ usage }: TokenLineProps) {
  const badge = usageBadge(usage);
  if (badge !== null && badge.kind === 'unavailable') {
    return (
      <span className="token-line">
        <TagBadge tone="unknown" tip={badge.tip}>
          {badge.text}
        </TagBadge>
      </span>
    );
  }
  return (
    <span className="token-line">
      <span className="token-line__text">{tokenLine(usage)}</span>
      {badge === null ? null : (
        <TagBadge tone="partial" tip={badge.tip}>
          {badge.text}
        </TagBadge>
      )}
    </span>
  );
}

import type { CostEstimate, TokenUsage } from '@mcs/shared';

import { fmtTokOrNa, usageBadge } from '../lib/format.ts';
import { TagBadge } from './TagBadge.tsx';
import { TokenLine } from './TokenLine.tsx';

export interface TokenSummaryProps {
  usage: TokenUsage | null;
  cost?: CostEstimate | null | undefined;
  layout: 'line' | 'grid';
  /** The numbers include the subagents of the session. */
  includesSubagents?: boolean | undefined;
}

function Cost({ cost }: { cost: CostEstimate }) {
  const covers = cost.pricedTokensPct < 100;
  return (
    <span className="token-summary__cost">
      Estimated cost (configured prices): {cost.amount.toFixed(2)} {cost.currency}
      {covers ? `, covers ${String(Math.round(cost.pricedTokensPct))}% of tokens` : ''}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="token-summary__figure">
      <dt>{label}</dt>
      <dd title={value === null ? 'not available' : String(value)}>{fmtTokOrNa(value)}</dd>
    </div>
  );
}

/** Token numbers of a session or an agent: one line for lists and headers, a labelled grid for the Tokens tab. */
export function TokenSummary({ usage, cost, layout, includesSubagents = false }: TokenSummaryProps) {
  if (layout === 'line') {
    return (
      <div className="token-summary token-summary--line">
        <TokenLine usage={usage} />
        {includesSubagents ? <span className="muted">(incl. subagents)</span> : null}
        {cost === null || cost === undefined ? null : <Cost cost={cost} />}
      </div>
    );
  }
  const badge = usageBadge(usage);
  return (
    <div className="token-summary token-summary--grid">
      <dl className="token-summary__figures">
        <Figure label="Input" value={usage?.input ?? null} />
        <Figure label="Output" value={usage?.output ?? null} />
        <Figure label="Cache creation" value={usage?.cacheCreation ?? null} />
        <Figure label="Cache read" value={usage?.cacheRead ?? null} />
        <Figure label="Turns" value={usage?.turns ?? null} />
      </dl>
      {badge === null ? null : (
        <TagBadge tone={badge.kind === 'partial' ? 'partial' : 'unknown'} tip={badge.tip}>
          {badge.text}
        </TagBadge>
      )}
      {includesSubagents ? <span className="muted">(incl. subagents)</span> : null}
      {cost === null || cost === undefined ? null : <Cost cost={cost} />}
    </div>
  );
}

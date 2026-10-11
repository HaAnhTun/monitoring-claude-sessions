import type { AgentNode, SessionDetail } from '@mcs/shared';

import { TokenLine } from '../../components/TokenLine.tsx';
import { TokenSummary } from '../../components/TokenSummary.tsx';

export interface SessionTokensProps {
  session: SessionDetail;
  agents: AgentNode[];
}

/**
 * Token numbers of the session (the totals include the subagents) and of every agent. A number the monitor does not have is
 * "n/a" and a scan that is not complete is labelled "lower bound" (both from `TokenLine`, which reads `usage.lowerBound` and
 * `usage.completeness`).
 */
export function SessionTokens({ session, agents }: SessionTokensProps) {
  return (
    <section className="session-tokens" aria-label="Tokens">
      <p className="muted">Token numbers come from transcripts only; hooks carry no usage.</p>
      <TokenSummary usage={session.usageInclSubagents} cost={session.cost} layout="grid" includesSubagents />
      {agents.length === 0 ? null : (
        <div className="data-table-wrap">
          <table className="data-table">
            <caption className="sr-only">Tokens per agent</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Model</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <th scope="row">{agent.label}</th>
                  <td>{agent.model ?? <span className="muted">-</span>}</td>
                  <td>
                    <TokenLine usage={agent.usage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

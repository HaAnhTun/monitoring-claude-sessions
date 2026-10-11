import type { AgentNode, SessionDetail } from '@mcs/shared';
import type { ReactNode, Ref } from 'react';
import { Link, useLocation } from 'react-router';

import { CopyButton } from '../../components/CopyButton.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenSummary } from '../../components/TokenSummary.tsx';
import { fmtDuration } from '../../lib/format.ts';
import { AuditRefs } from './AuditRefs.tsx';

export interface SessionHeaderProps {
  session: SessionDetail;
  /** The chosen subagent; `null` is the main agent. */
  agent: AgentNode | null;
  /** The page heading is focused after a navigation (04 3.1 rule 5). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Shown right under the title row (banners). */
  children?: ReactNode;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="session-header__field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const NONE = <span className="muted">-</span>;

function text(value: string | null): ReactNode {
  return value === null || value === '' ? NONE : value;
}

/**
 * Title, state with the evidence behind it, identifying metadata, token totals and audit references of one session (04 4.4).
 * Every value is text; nothing from a transcript or an audit file is interpreted as markup.
 */
export function SessionHeader({ session, agent, headingRef, children }: SessionHeaderProps) {
  const { pathname, search } = useLocation();
  const title = agent === null || agent.kind === 'main' ? session.label : `${session.label} / ${agent.label}`;
  const state = session.state;
  return (
    <header className="session-header">
      <div className="session-header__title">
        <h1 ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        {session.labelSource === 'rule' ? (
          <TagBadge tone="neutral" tip="The label was set by a project rule">
            label from rule
          </TagBadge>
        ) : null}
        {session.matched ? null : (
          <TagBadge tone="neutral" tip="No project rule matched this session">
            not in list
          </TagBadge>
        )}
        <CopyButton label="Copy link" text={() => `${window.location.origin}${pathname}${search}`}>
          Copy link
        </CopyButton>
      </div>
      <div className="session-header__state">
        <StateBadge state={state.state} />
        <span className="muted">{`${state.basis} · ${state.confidence} confidence`}</span>
      </div>
      <Disclosure id="session-state-evidence" label="Why this state?">
        {state.evidence.length === 0 ? (
          <p className="muted">No evidence recorded.</p>
        ) : (
          <ul className="session-header__evidence">
            {state.evidence.map((item, index) => (
              <li key={`${item.kind}|${String(index)}`}>
                <span>{item.text}</span> <RelativeTime iso={item.at} mode="clock" />
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
      {children}
      <dl className="session-header__meta">
        <Field label="Session id">
          <span className="mono">{session.id}</span>
        </Field>
        <Field label="Project">{text(session.projectLabel)}</Field>
        <Field label="Work items">
          {session.workItems.length === 0 ? (
            NONE
          ) : (
            <ul className="session-header__items">
              {session.workItems.map((item) => (
                <li key={item.id}>
                  <Link to={`/sessions?task=${String(item.id)}`}>{item.title}</Link>{' '}
                  <TagBadge tone="neutral">{item.state}</TagBadge>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Provider">{session.provider}</Field>
        <Field label="Models">{session.models.length === 0 ? NONE : session.models.join(', ')}</Field>
        <Field label="Working directory">
          {session.cwd === null ? NONE : <span className="mono">{session.cwd}</span>}
        </Field>
        <Field label="Permission mode">{text(session.permissionMode)}</Field>
        <Field label="Started">
          <RelativeTime iso={session.startedAt} mode="both" />
        </Field>
        <Field label="Last activity">
          <RelativeTime iso={session.lastActivityAt} mode="both" />
        </Field>
        <Field label="Duration">{fmtDuration(session.durationMs / 1000)}</Field>
        <Field label="End reason">{text(state.endReason)}</Field>
      </dl>
      <TokenSummary usage={session.usageInclSubagents} cost={session.cost} layout="line" includesSubagents />
      <AuditRefs refs={session.auditRefs} />
    </header>
  );
}

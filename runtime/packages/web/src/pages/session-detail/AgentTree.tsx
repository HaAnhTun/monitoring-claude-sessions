import type { AgentNode } from '@mcs/shared';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenLine } from '../../components/TokenLine.tsx';
import { buildAgentTree, type AgentTreeNode } from '../../lib/agent-tree.ts';
import { plural } from '../../lib/format.ts';
import { AGENT_PAGE, LAZY_AGENT_THRESHOLD, type AgentGroup } from '../../lib/sessions-view.ts';

export interface AgentTreeProps {
  sessionId: string;
  /** The flat list of `GET /sessions/:id/agents`. */
  agents: AgentNode[];
  /** `null` (or '') is the main agent. */
  selectedAgentId: string | null;
}

type Group = AgentGroup<AgentTreeNode<AgentNode>>;

const MAIN_ID = 'main';
const ENDED_STATES: readonly string[] = ['completed', 'failed'];
const RULE_TEXT = 'A subagent ending never completes its parent.';

/** D9: show the rule when the parent is still going although every subagent below it has ended. */
function ruleApplies(parentState: string | null, groups: readonly Group[]): boolean {
  if (parentState === null || ENDED_STATES.includes(parentState)) return false;
  const children = groups.flatMap((group) => group.agents);
  return children.length > 0 && children.every((child) => ENDED_STATES.includes(child.agent.state.state));
}

function transcriptLink(sessionId: string, agentId: string): string {
  const agent = agentId === MAIN_ID ? '' : `&agent=${encodeURIComponent(agentId)}`;
  return `/sessions/${sessionId}?tab=transcript${agent}`;
}

interface RowProps {
  sessionId: string;
  agent: AgentNode;
  orphan: boolean;
}

function AgentRowSummary({ sessionId, agent, orphan }: RowProps) {
  return (
    <div className="agent-row">
      <StateBadge state={agent.state.state} size="sm" />
      <span className="agent-row__label">{agent.label}</span>
      {orphan ? (
        <TagBadge tone="partial" tip="The parent of this agent is not part of the loaded list">
          parent not loaded
        </TagBadge>
      ) : null}
      {agent.agentType === null ? null : <span className="muted">{agent.agentType}</span>}
      {agent.model === null ? null : <span className="muted mono">{agent.model}</span>}
      <RelativeTime iso={agent.lastActivityAt} />
      <TokenLine usage={agent.usage} />
      {agent.errorCount > 0 ? (
        <span className="agent-row__errors">
          <Icon name="failed" />
          <span>{plural(agent.errorCount, 'error')}</span>
        </span>
      ) : null}
      <Link
        to={transcriptLink(sessionId, agent.id)}
        aria-label={`Open transcript of ${agent.label}`}
        className="agent-row__link"
      >
        Open transcript
      </Link>
    </div>
  );
}

interface TreeState {
  /** Explicit open state per group; groups of more than `LAZY_AGENT_THRESHOLD` agents start closed. */
  open: ReadonlyMap<string, boolean>;
  shown: ReadonlyMap<string, number>;
  toggle: (key: string, open: boolean) => void;
  more: (key: string) => void;
}

interface NodeProps {
  sessionId: string;
  selectedId: string;
  node: AgentTreeNode<AgentNode>;
  idBase: string;
  state: TreeState;
}

function GroupList({
  sessionId,
  selectedId,
  groups,
  parentKey,
  idBase,
  state,
}: Omit<NodeProps, 'node'> & { groups: readonly Group[]; parentKey: string }) {
  return (
    <>
      {groups.map((group) => {
        const key = `${parentKey}|${group.key}`;
        const open = state.open.get(key) ?? group.agents.length <= LAZY_AGENT_THRESHOLD;
        const shown = state.shown.get(key) ?? AGENT_PAGE;
        const rest = group.agents.length - shown;
        return (
          <section key={key} className="agent-group">
            <Disclosure
              id={`${idBase}-${encodeURIComponent(key)}`}
              open={open}
              onToggle={(next) => {
                state.toggle(key, next);
              }}
              label={
                <span className="agent-group__label">
                  <span>{group.title}</span>{' '}
                  <span className="muted">{`(${String(group.agents.length)})${group.summary === '' ? '' : ` · ${group.summary}`}`}</span>
                  {group.workflowState === null ? null : <StateBadge state={group.workflowState} size="sm" />}
                </span>
              }
            >
              {open ? (
                <>
                  <ul className="agent-tree__list">
                    {group.agents.slice(0, shown).map((child) => (
                      <AgentNodeRow
                        key={child.agent.id}
                        sessionId={sessionId}
                        selectedId={selectedId}
                        node={child}
                        idBase={idBase}
                        state={state}
                      />
                    ))}
                  </ul>
                  {rest > 0 ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        state.more(key);
                      }}
                    >
                      {`Show ${String(Math.min(rest, AGENT_PAGE))} more`}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </Disclosure>
          </section>
        );
      })}
    </>
  );
}

function AgentNodeRow({ sessionId, selectedId, node, idBase, state }: NodeProps) {
  const { agent } = node;
  return (
    <li aria-current={agent.id === selectedId ? 'true' : undefined} className="agent-tree__item">
      <AgentRowSummary sessionId={sessionId} agent={agent} orphan={node.orphan} />
      {node.children.length === 0 ? null : (
        <div className="agent-tree__children">
          {ruleApplies(agent.state.state, node.children) ? <p className="muted agent-tree__rule">{RULE_TEXT}</p> : null}
          <GroupList
            sessionId={sessionId}
            selectedId={selectedId}
            groups={node.children}
            parentKey={agent.id}
            idBase={idBase}
            state={state}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The agents of a session as a nested list (04 4.4.2): the main agent first, then subagents and workflow runs grouped
 * under their parents. Not an ARIA tree, so the keyboard model stays the one of buttons and links.
 */
export function AgentTree({ sessionId, agents, selectedAgentId }: AgentTreeProps) {
  const idBase = `agents-${useId().replaceAll(':', '')}`;
  const tree = useMemo(() => buildAgentTree(agents), [agents]);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const state: TreeState = {
    open,
    shown,
    toggle: (key, next) => {
      setOpen((previous) => new Map(previous).set(key, next));
    },
    more: (key) => {
      setShown((previous) => new Map(previous).set(key, (previous.get(key) ?? AGENT_PAGE) + AGENT_PAGE));
    },
  };

  if (tree.count === 0) return <EmptyState title="This session has no subagents." icon="bot" />;

  const main = agents.find((agent) => agent.kind === 'main');
  const selectedId = selectedAgentId === null || selectedAgentId === '' ? MAIN_ID : selectedAgentId;
  return (
    <div className="agent-tree">
      {main === undefined ? null : (
        <ul className="agent-tree__list">
          <li aria-current={selectedId === main.id || selectedId === MAIN_ID ? 'true' : undefined}>
            <AgentRowSummary sessionId={sessionId} agent={main} orphan={false} />
          </li>
        </ul>
      )}
      {ruleApplies(main?.state.state ?? null, tree.groups) ? (
        <p className="muted agent-tree__rule">{RULE_TEXT}</p>
      ) : null}
      <GroupList
        sessionId={sessionId}
        selectedId={selectedId}
        groups={tree.groups}
        parentKey="root"
        idBase={idBase}
        state={state}
      />
    </div>
  );
}

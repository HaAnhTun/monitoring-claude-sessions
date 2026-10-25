import type { AgentNode } from '@mcs/shared';
import { useId, useMemo, useState, type CSSProperties } from 'react';

import { Button } from '../../components/Button.tsx';
import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useT } from '../../i18n/context.ts';
import { buildAgentTree, flattenNodes, isMainAgent, type AgentRow, type AgentTreeNode } from '../../lib/agent-tree.ts';
import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import {
  AGENT_PAGE,
  LAZY_AGENT_THRESHOLD,
  agentGroupTitle,
  stateSummaryParts,
  stateSummaryText,
  type AgentGroup,
} from '../../lib/sessions-view.ts';

export interface AgentTreeProps {
  sessionId: string;
  /** The flat list of `GET /sessions/:id/agents`. */
  agents: AgentNode[];
  /** `null` (or '') is the main agent. */
  selectedAgentId: string | null;
}

type Node = AgentTreeNode<AgentNode>;
type Group = AgentGroup<Node>;
type Row = AgentRow<AgentNode>;

const MAIN_ID = 'main';
const ENDED_STATES: readonly string[] = ['completed', 'failed'];

/** D9: the rule applies when the parent is still going although every subagent below it has ended. */
function ruleApplies(parentState: string, groups: readonly Group[]): boolean {
  if (ENDED_STATES.includes(parentState)) return false;
  const children = groups.flatMap((group) => group.agents);
  return children.length > 0 && children.every((child) => ENDED_STATES.includes(child.agent.state.state));
}

/** The ids of the agents for which the rule of D9 applies, from the main agent down. */
function agentsWithRule(main: AgentNode | null, groups: readonly Group[]): ReadonlySet<string> {
  const ids = new Set<string>();
  if (main !== null && ruleApplies(main.state.state, groups)) ids.add(main.id);
  const visit = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0 && ruleApplies(node.agent.state.state, node.children)) ids.add(node.agent.id);
      for (const group of node.children) visit(group.agents);
    }
  };
  for (const group of groups) visit(group.agents);
  return ids;
}

function transcriptLink(sessionId: string, agent: AgentNode): string {
  const part = isMainAgent(agent) ? '' : `&agent=${encodeURIComponent(agent.id)}`;
  return `/sessions/${encodeURIComponent(sessionId)}?tab=transcript${part}`;
}

// ---- cells -----------------------------------------------------------------------------------------------------------------

function StateCell({ row, rule }: { row: Row; rule: boolean }) {
  const t = useT();
  const { agent } = row;
  return (
    <StateBadge
      state={agent.state.state}
      assessment={agent.state}
      lastActivityAt={agent.lastActivityAt}
      size="sm"
      {...(rule
        ? { evidenceTip: `${t(lifecycleDisplay(agent.state.state).descriptionKey)} ${t('tabs.agents.rule')}` }
        : {})}
    />
  );
}

function AgentCell({ row }: { row: Row }) {
  const t = useT();
  const { agent } = row;
  // the indent of a subagent below its parent: one step per level
  const style: CSSProperties = { paddingInlineStart: `calc(${String(row.depth)} * var(--sp-6))` };
  return (
    <span className="agent-cell" data-depth={row.depth} style={style}>
      <span className="agent-cell__label">{agent.label}</span>
      {agent.agentType === null ? null : <span className="muted agent-cell__type">{agent.agentType}</span>}
      {row.orphan ? (
        <TagBadge tone="partial" tip={t('tabs.agents.orphan.tip')}>
          {t('tabs.agents.orphan')}
        </TagBadge>
      ) : null}
      {row.depth > 0 && agent.workflow !== null ? (
        <TagBadge tone="neutral">
          {t('tabs.agents.nested', { workflow: agent.workflow.name ?? agent.workflow.runId })}
        </TagBadge>
      ) : null}
      <span className="sr-only">{t('tabs.agents.openTranscript')}</span>
    </span>
  );
}

function TokensCell({ agent }: { agent: AgentNode }) {
  const t = useT();
  return (
    <span className="agent-tokens">
      <span>
        <span className="muted">{t('tokens.output')}</span>{' '}
        <TokenFigures usage={agent.usage} variant="cell" figure="output" />
      </span>
      <span>
        <span className="muted">{t('tokens.inputNew')}</span>{' '}
        <TokenFigures usage={agent.usage} variant="cell" figure="inputNew" />
      </span>
    </span>
  );
}

function ErrorsCell({ agent }: { agent: AgentNode }) {
  const t = useT();
  if (agent.errorCount === 0) return null;
  return (
    <span className="session-errors__chip">
      <Icon name="failed" />
      <span>{t('sessions.errors.count', { count: agent.errorCount })}</span>
    </span>
  );
}

// ---- one table ---------------------------------------------------------------------------------------------------------------

interface TableProps {
  sessionId: string;
  caption: string;
  rows: Row[];
  selectedId: string;
  rule: ReadonlySet<string>;
}

function rowKey(row: Row): string {
  return row.agent.id;
}

/** The agents of one group (or the main agent alone) in the style of the Sessions table: State, Agent, Model, Last seen, Tokens. */
function AgentTable({ sessionId, caption, rows, selectedId, rule }: TableProps) {
  const t = useT();
  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        id: 'state',
        header: t('tabs.agents.col.state'),
        nowrap: true,
        cell: (row) => <StateCell row={row} rule={rule.has(row.agent.id)} />,
      },
      { id: 'agent', header: t('tabs.agents.col.agent'), link: true, cell: (row) => <AgentCell row={row} /> },
      {
        id: 'model',
        header: t('tabs.agents.col.model'),
        priority: 2,
        nowrap: true,
        cell: (row) => row.agent.model,
      },
      {
        id: 'lastSeen',
        header: t('tabs.agents.col.lastSeen'),
        nowrap: true,
        cell: (row) => <RelativeTime iso={row.agent.lastActivityAt} />,
      },
      {
        id: 'tokens',
        header: t('tabs.agents.col.tokens'),
        headerTitle: t('tabs.agents.col.tokens.tip'),
        numeric: true,
        cell: (row) => <TokensCell agent={row.agent} />,
      },
      {
        id: 'errors',
        header: t('tabs.agents.col.errors'),
        nowrap: true,
        cell: (row) => <ErrorsCell agent={row.agent} />,
      },
    ],
    [t, rule],
  );
  const card = useMemo(
    () =>
      (row: Row): DataCard => ({
        lead: <StateCell row={row} rule={rule.has(row.agent.id)} />,
        title: <AgentCell row={row} />,
        end: <RelativeTime iso={row.agent.lastActivityAt} />,
        meta: (
          <>
            <ErrorsCell agent={row.agent} />
            <TokensCell agent={row.agent} />
          </>
        ),
      }),
    [rule],
  );
  return (
    <DataTable<Row>
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={rowKey}
      rowHref={(row) => transcriptLink(sessionId, row.agent)}
      selectedKey={selectedId}
      card={card}
    />
  );
}

// ---- the tab -----------------------------------------------------------------------------------------------------------------

/**
 * The agents of a session (review R-14): a line that counts the subagents (the main agent is not one of them), the main agent as a
 * row of its own, then the subagents and workflow runs in groups, each a table of the same style as the Sessions list. A subagent
 * that has children is followed by them, indented. Not an ARIA tree, so the keyboard model stays the one of buttons and links.
 */
export function AgentTree({ sessionId, agents, selectedAgentId }: AgentTreeProps) {
  const t = useT();
  const idBase = `agents-${useId().replaceAll(':', '')}`;
  const tree = useMemo(() => buildAgentTree(agents), [agents]);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const rule = useMemo(() => agentsWithRule(tree.main, tree.groups), [tree]);
  const subagentSummary = useMemo(
    () => stateSummaryText(stateSummaryParts(agents.filter((agent) => !isMainAgent(agent))), t),
    [agents, t],
  );

  if (tree.main === null && tree.count === 0) return <EmptyState title={t('tabs.agents.none')} icon="bot" />;

  const selectedId = selectedAgentId === null || selectedAgentId === '' ? MAIN_ID : selectedAgentId;
  const mainRow: Row[] = tree.main === null ? [] : [{ agent: tree.main, orphan: false, depth: 0 }];
  const mainSelected = tree.main !== null && (selectedId === tree.main.id || selectedId === MAIN_ID);
  return (
    <div className="agent-tree">
      <p className="agent-tree__summary">
        {tree.count === 0 ? (
          <span>{t('tabs.agents.mainOnly')}</span>
        ) : (
          <>
            <span>{t('tabs.agents.summary', { count: tree.count })}</span>
            <span className="muted">{subagentSummary}</span>
          </>
        )}
      </p>
      {tree.main === null ? null : (
        <AgentTable
          sessionId={sessionId}
          caption={t('tabs.agents.captionMain')}
          rows={mainRow}
          selectedId={mainSelected ? tree.main.id : selectedId}
          rule={rule}
        />
      )}
      {tree.groups.map((group) => {
        const key = group.key;
        const isOpen = open.get(key) ?? group.agents.length <= LAZY_AGENT_THRESHOLD;
        const limit = shown.get(key) ?? AGENT_PAGE;
        const rest = group.agents.length - limit;
        const title = agentGroupTitle(group, t);
        const summary = stateSummaryText(group.summaryParts, t);
        return (
          <section key={key === '' ? 'plain' : key} className="agent-group">
            <Disclosure
              id={`${idBase}-${encodeURIComponent(key === '' ? 'plain' : key)}`}
              open={isOpen}
              onToggle={(next) => {
                setOpen((previous) => new Map(previous).set(key, next));
              }}
              label={
                <span className="agent-group__label">
                  <span>{title}</span>{' '}
                  <span className="muted">{`(${String(group.agents.length)})${summary === '' ? '' : ` · ${summary}`}`}</span>
                  {group.workflowState === null ? null : <StateBadge state={group.workflowState} size="sm" />}
                </span>
              }
            >
              {isOpen ? (
                <>
                  <AgentTable
                    sessionId={sessionId}
                    caption={t('tabs.agents.captionGroup', { group: title })}
                    rows={flattenNodes(group.agents.slice(0, limit))}
                    selectedId={selectedId}
                    rule={rule}
                  />
                  {rest > 0 ? (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setShown((previous) => new Map(previous).set(key, limit + AGENT_PAGE));
                      }}
                    >
                      {t('tabs.agents.showMore', { count: Math.min(rest, AGENT_PAGE) })}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </Disclosure>
          </section>
        );
      })}
    </div>
  );
}

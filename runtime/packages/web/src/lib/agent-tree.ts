// Agent tree from the flat agent list of `GET /sessions/:id/agents` (04 4.4.2). Pure: parents, orphans, cycle guard,
// workflow grouping and ordering.
import { groupItems, type AgentGroup, type GroupableAgent } from './sessions-view.ts';

/** The fields of `AgentNode` the tree reads; the real type satisfies it. */
export interface TreeAgent extends GroupableAgent {
  id: string;
  /** 'main' is the session root itself and is not a node of the tree. */
  kind: string;
  parentAgentId: string | null;
  startedAt: string;
}

export interface AgentTreeNode<A extends TreeAgent> {
  agent: A;
  /** Parent not loaded or on a cycle: attached to the session root. */
  orphan: boolean;
  /** Children grouped as plain subagents, then workflow runs. */
  children: AgentGroup<AgentTreeNode<A>>[];
}

export interface AgentTree<A extends TreeAgent> {
  /** Children of the session root, grouped. */
  groups: AgentGroup<AgentTreeNode<A>>[];
  /** Agents in the tree (the main agent is not counted). */
  count: number;
  orphans: number;
}

const ROOT_ID = 'main';

function byStart(a: TreeAgent, b: TreeAgent): number {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function buildAgentTree<A extends TreeAgent>(agents: readonly A[]): AgentTree<A> {
  const index = new Map<string, A>();
  for (const a of agents) index.set(a.id, a);
  const isRoot = (id: string): boolean => id === ROOT_ID || index.get(id)?.kind === 'main';
  const members = agents.filter((a) => a.kind !== 'main');

  // Parent of an agent inside the tree: undefined = attached to the session root.
  const parentOf = (a: A): A | undefined => {
    if (a.parentAgentId === null || isRoot(a.parentAgentId)) return undefined;
    return index.get(a.parentAgentId);
  };

  // Agents that sit on a parent cycle (including a self parent).
  const onCycle = new Set<string>();
  for (const start of members) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: A | undefined = start;
    while (cursor !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      path.push(cursor.id);
      cursor = parentOf(cursor);
    }
    if (cursor !== undefined) for (const id of path.slice(path.indexOf(cursor.id))) onCycle.add(id);
  }

  const nodes = new Map<string, AgentTreeNode<A>>();
  const childrenOf = new Map<string, A[]>();
  const rootChildren: A[] = [];
  let orphans = 0;
  for (const a of members) {
    const missingParent = a.parentAgentId !== null && !isRoot(a.parentAgentId) && !index.has(a.parentAgentId);
    const orphan = missingParent || onCycle.has(a.id);
    if (orphan) orphans += 1;
    nodes.set(a.id, { agent: a, orphan, children: [] });
    const parent = orphan ? undefined : parentOf(a);
    if (parent === undefined) rootChildren.push(a);
    else childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), a]);
  }

  const groupOf = (list: readonly A[]): AgentGroup<AgentTreeNode<A>>[] => {
    const sorted = [...list].sort(byStart);
    const nodeList = sorted.flatMap((a) => nodes.get(a.id) ?? []);
    return groupItems(nodeList, (n) => n.agent);
  };
  for (const [id, node] of nodes) node.children = groupOf(childrenOf.get(id) ?? []);

  return { groups: groupOf(rootChildren), count: members.length, orphans };
}

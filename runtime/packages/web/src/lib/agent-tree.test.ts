// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildAgentTree, flattenNodes, isMainAgent, type AgentTreeNode, type TreeAgent } from './agent-tree.ts';

function agent(id: string, over: Partial<TreeAgent> = {}): TreeAgent {
  return {
    id,
    kind: 'subagent',
    parentAgentId: 'main',
    startedAt: '2026-10-11T10:00:00.000Z',
    workflow: null,
    state: { state: 'running' },
    ...over,
  };
}

const MAIN = agent('main', { kind: 'main', parentAgentId: null });

function ids(nodes: readonly AgentTreeNode<TreeAgent>[]): string[] {
  return nodes.map((n) => n.agent.id);
}

function rootIds(tree: ReturnType<typeof buildAgentTree<TreeAgent>>): string[] {
  return tree.groups.flatMap((g) => ids(g.agents));
}

describe('agent tree', () => {
  it('attaches children to their parents and the main agent is the session root, not a node', () => {
    const tree = buildAgentTree([
      MAIN,
      agent('a', { startedAt: '2026-10-11T10:00:01.000Z' }),
      agent('b', { parentAgentId: 'a', startedAt: '2026-10-11T10:00:02.000Z' }),
      agent('c', { parentAgentId: 'b', startedAt: '2026-10-11T10:00:03.000Z' }),
    ]);
    expect(rootIds(tree)).toEqual(['a']);
    const a = tree.groups[0]?.agents[0];
    expect(a?.orphan).toBe(false);
    expect(a?.children.flatMap((g) => ids(g.agents))).toEqual(['b']);
    const b = a?.children[0]?.agents[0];
    expect(b?.children.flatMap((g) => ids(g.agents))).toEqual(['c']);
    expect(tree.count).toBe(3);
    expect(tree.orphans).toBe(0);
  });

  it('works without a main agent in the list: a parent reference to "main" is the root', () => {
    const tree = buildAgentTree([agent('a'), agent('b', { parentAgentId: 'a' })]);
    expect(rootIds(tree)).toEqual(['a']);
    expect(tree.orphans).toBe(0);
  });

  it('a missing parent makes an orphan root', () => {
    const tree = buildAgentTree([MAIN, agent('a'), agent('lost', { parentAgentId: 'not-loaded' })]);
    expect(rootIds(tree).sort()).toEqual(['a', 'lost']);
    const lost = tree.groups.flatMap((g) => g.agents).find((n) => n.agent.id === 'lost');
    expect(lost?.orphan).toBe(true);
    expect(tree.groups.flatMap((g) => g.agents).find((n) => n.agent.id === 'a')?.orphan).toBe(false);
    expect(tree.orphans).toBe(1);
  });

  it('a cycle makes orphan roots and a branch hanging off it stays attached', () => {
    const tree = buildAgentTree([
      MAIN,
      agent('x', { parentAgentId: 'y' }),
      agent('y', { parentAgentId: 'x' }),
      agent('z', { parentAgentId: 'x' }),
      agent('self', { parentAgentId: 'self' }),
    ]);
    const roots = tree.groups.flatMap((g) => g.agents);
    expect(ids(roots).sort()).toEqual(['self', 'x', 'y']);
    expect(roots.every((n) => n.orphan)).toBe(true);
    const x = roots.find((n) => n.agent.id === 'x');
    expect(x?.children.flatMap((g) => ids(g.agents))).toEqual(['z']);
    expect(tree.count).toBe(4);
    expect(tree.orphans).toBe(3);
  });

  it('groups children into plain subagents first, then workflow runs, with a state summary', () => {
    const run = { runId: 'run-1', name: 'release', phase: 'build', state: 'running' } as const;
    const tree = buildAgentTree([
      MAIN,
      agent('w1', { workflow: run, state: { state: 'completed' } }),
      agent('w2', { workflow: run, state: { state: 'running' } }),
      agent('p1', { state: { state: 'failed' } }),
    ]);
    expect(tree.groups.map((g) => [g.key, g.titleKey, g.titleArgs, g.agents.length, g.summaryParts])).toEqual([
      ['', 'shell.agents.subagents', null, 1, [{ key: 'shell.agents.summary.failed', count: 1 }]],
      [
        'run-1',
        'shell.agents.workflow',
        { name: 'release' },
        2,
        [
          { key: 'shell.agents.summary.running', count: 1 },
          { key: 'shell.agents.summary.completed', count: 1 },
        ],
      ],
    ]);
    expect(tree.groups[1]?.workflowState).toBe('running');
  });

  it('sorts inside a group by start time, then by id', () => {
    const tree = buildAgentTree([
      agent('b', { startedAt: '2026-10-11T10:00:05.000Z' }),
      agent('d', { startedAt: '2026-10-11T10:00:01.000Z' }),
      agent('c', { startedAt: '2026-10-11T10:00:05.000Z' }),
      agent('a', { startedAt: '2026-10-11T10:00:09.000Z' }),
    ]);
    expect(rootIds(tree)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('an empty list gives an empty tree and the input is not changed', () => {
    expect(buildAgentTree([])).toEqual({ main: null, groups: [], count: 0, orphans: 0 });
    const input = [agent('b'), agent('a')];
    const copy = [...input];
    buildAgentTree(input);
    expect(input).toEqual(copy);
  });

  it('keeps the main agent out of the count and hands it back as the root', () => {
    const tree = buildAgentTree([MAIN, agent('a'), agent('b')]);
    expect(tree.main?.id).toBe('main');
    expect(tree.count).toBe(2);
    expect(rootIds(tree)).toEqual(['a', 'b']);
    expect(buildAgentTree([MAIN]).count).toBe(0);
    expect(buildAgentTree([MAIN]).main?.id).toBe('main');
    expect(buildAgentTree([agent('a')]).main).toBeNull();
  });

  it('reads the agent called main as the main agent even when its kind says otherwise', () => {
    expect(isMainAgent({ id: 'main', kind: 'subagent' })).toBe(true);
    expect(isMainAgent({ id: 'x', kind: 'main' })).toBe(true);
    expect(isMainAgent({ id: 'x', kind: 'subagent' })).toBe(false);
    const tree = buildAgentTree([agent('main', { kind: 'subagent', parentAgentId: null }), agent('a')]);
    expect(tree.count).toBe(1);
    expect(rootIds(tree)).toEqual(['a']);
  });

  it('flattens depth first with the depth of every agent, orphans and cycles included', () => {
    const tree = buildAgentTree([
      MAIN,
      agent('a', { startedAt: '2026-10-11T10:00:01.000Z' }),
      agent('a1', { parentAgentId: 'a', startedAt: '2026-10-11T10:00:02.000Z' }),
      agent('a1x', { parentAgentId: 'a1', startedAt: '2026-10-11T10:00:03.000Z' }),
      agent('a2', { parentAgentId: 'a', startedAt: '2026-10-11T10:00:04.000Z' }),
      agent('b', { startedAt: '2026-10-11T10:00:05.000Z' }),
      agent('lost', { parentAgentId: 'not-loaded', startedAt: '2026-10-11T10:00:06.000Z' }),
      agent('loop1', { parentAgentId: 'loop2', startedAt: '2026-10-11T10:00:07.000Z' }),
      agent('loop2', { parentAgentId: 'loop1', startedAt: '2026-10-11T10:00:08.000Z' }),
    ]);
    const rows = flattenNodes(tree.groups.flatMap((group) => group.agents));
    expect(rows.map((row) => [row.agent.id, row.depth, row.orphan])).toEqual([
      ['a', 0, false],
      ['a1', 1, false],
      ['a1x', 2, false],
      ['a2', 1, false],
      ['b', 0, false],
      ['lost', 0, true],
      ['loop1', 0, true],
      ['loop2', 0, true],
    ]);
    expect(tree.count).toBe(8);
    expect(tree.orphans).toBe(3);
  });
});

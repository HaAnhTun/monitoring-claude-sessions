// TC-ATT-20 (ADR 0107): the "Needs you" strip. Nothing at all while no session needs the person; else the blocked sessions
// first, five rows at most, the rest as a count; a failed or finished row can be marked as seen.
import type { AttentionClass } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AttentionItem } from '../../lib/attention-rows.ts';
import { stripOf } from '../../lib/workspace-attention.ts';
import { iso, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { NeedsYouStrip } from './NeedsYouStrip.tsx';

const CANARY_LABEL = 'CANARY label of a terminal session';

const NEEDS: AttentionClass = { posture: 'needs_you', reason: 'permission', family: 'S-6' };
const FAILED: AttentionClass = { posture: 'failed', reason: 'session_failed', family: 'S-3' };
const DONE: AttentionClass = { posture: 'ready', reason: 'turn_done', family: 'S-8' };
const WORKING: AttentionClass = { posture: 'working', reason: null, family: 'S-7' };

/** A terminal row `fixture-term-<n>` linked to session `n`; its label must never be drawn. */
function terminalItem(n: number, level: AttentionItem['level'], cls: AttentionClass): AttentionItem {
  return {
    key: `s:${sessionId(n)}`,
    sessionId: sessionId(n),
    terminal: `fixture-term-${String(n)}`,
    folderKey: 'fixture-app-1',
    cls,
    since: iso(-60 * n),
    label: CANARY_LABEL,
    labelSource: 'custom_title',
    level,
    unseen: true,
  };
}

function renderStrip(items: readonly AttentionItem[]) {
  const onMarkSeen = vi.fn<(keys: readonly string[]) => void>();
  const rendered = renderWithIntl(<NeedsYouStrip model={stripOf(items)} titles="named" onMarkSeen={onMarkSeen} />);
  return { ...rendered, onMarkSeen };
}

describe('NeedsYouStrip', () => {
  it('renders nothing while no session needs the person', () => {
    const { container } = renderStrip([terminalItem(1, 'working', WORKING), terminalItem(2, 'idle', DONE)]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the blocked sessions first, five rows at most and the rest as a count', async () => {
    const user = userEvent.setup();
    const session = {
      ...terminalItem(9, 'needs_you', { posture: 'needs_you', reason: 'question', family: 'S-6' }),
      terminal: null,
      folderKey: null,
      label: 'Named fixture session',
    };
    const { onMarkSeen } = renderStrip([
      terminalItem(1, 'done', DONE),
      terminalItem(2, 'failed', FAILED),
      terminalItem(3, 'working', WORKING),
      terminalItem(4, 'needs_you', NEEDS),
      terminalItem(5, 'done', DONE),
      terminalItem(6, 'failed', FAILED),
      terminalItem(7, 'needs_you', NEEDS),
      session,
    ]);
    const strip = screen.getByRole('region', { name: msg('workspace.attention.heading', { count: 7 }) });
    const rows = within(strip).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.dataset['level'])).toEqual([
      'needs_you',
      'needs_you',
      'needs_you',
      'failed',
      'failed',
    ]);
    expect(within(strip).getByText(msg('workspace.attention.more', { count: 2 }))).toBeVisible();

    // a terminal row: the level in a word, the terminal name and the reason; a link that selects it and asks for the focus
    const first = within(strip).getByRole('link', { name: /fixture-term-7/ });
    expect(first).toHaveAttribute('href', '/?session=fixture-term-7');
    expect(first).toHaveTextContent(msg('workspace.attention.level.needs_you'));
    expect(first).toHaveTextContent(msg('workspace.attention.reason.permission'));
    // a session that is no terminal: its allowed title, and a link to its page
    const other = within(strip).getByRole('link', { name: /Named fixture session/ });
    expect(other).toHaveAttribute('href', `/sessions/${sessionId(9)}`);
    expect(other).toHaveTextContent(msg('workspace.attention.reason.question'));
    // the label of a terminal is never drawn
    expect(strip).not.toHaveTextContent('CANARY');

    // only a failed or finished row can be marked as seen; "Dismiss all" takes every such row, drawn or not
    expect(within(strip).getAllByRole('button', { name: /fixture-term/ })).toHaveLength(2);
    await user.click(
      within(strip).getByRole('button', { name: msg('workspace.attention.markSeen.name', { name: 'fixture-term-2' }) }),
    );
    expect(onMarkSeen).toHaveBeenLastCalledWith([`s:${sessionId(2)}`]);
    await user.click(within(strip).getByRole('button', { name: msg('workspace.attention.dismissAll') }));
    expect(onMarkSeen.mock.lastCall?.[0]).toHaveLength(4);
  });
});

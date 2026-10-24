import type { TranscriptEntry } from '@mcs/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type * as MarkdownModule from '../components/Markdown.tsx';

import { pairEvents, type Unit } from '../lib/timeline-model.ts';
import { iso } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { TranscriptRow } from './TranscriptRow.tsx';

const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/Markdown.tsx', async (importOriginal) => {
  const real = await importOriginal<typeof MarkdownModule>();
  return {
    ...real,
    Markdown: (props: Parameters<typeof real.Markdown>[0]) => {
      markdownRenders.count += 1;
      return <real.Markdown {...props} />;
    },
  };
});

function unitOf(entry: Omit<TranscriptEntry, 'i' | 't'> & { i?: number }): Unit {
  const unit = pairEvents([{ i: entry.i ?? 5, t: iso(0), ...entry }])[0];
  if (unit === undefined) throw new Error('fixture produced no unit');
  return unit;
}

function renderRow(unit: Unit, props: Partial<Parameters<typeof TranscriptRow>[0]> = {}) {
  return renderWithIntl(
    <ol>
      <TranscriptRow
        unit={unit}
        hidden={false}
        expanded={false}
        isTarget={false}
        onToggleExpanded={() => undefined}
        {...props}
      />
    </ol>,
  );
}

describe('TranscriptRow', () => {
  it('renders a keyed list item with the kind label, index button and clock time', () => {
    const { container } = renderRow(unitOf({ k: 'say', text: 'hello **world**' }));
    const row = container.querySelector('li');
    expect(row).toHaveAttribute('data-row-key', 'e5');
    expect(row).toHaveClass('tr', 'tr--say');
    expect(screen.getByText(msg('transcript.kind.say'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('transcript.row.copyIndex') })).toHaveTextContent('#5');
    expect(container.querySelector('time')).toHaveTextContent('12:00:00');
    expect(container.querySelector('time')).toHaveAttribute('datetime', iso(0));
  });

  it('renders prompt and say text through Markdown and think and result as plain text', () => {
    const { container, rerender } = renderRow(unitOf({ k: 'prompt', text: 'see `code` and <b>tag</b>' }));
    expect(container.querySelector('.md-p code.md-inline')?.textContent).toBe('code');
    expect(container.querySelector('b')).toBeNull();
    rerender(
      <ol>
        <TranscriptRow
          unit={unitOf({ k: 'think', text: '```not a fence```' })}
          hidden={false}
          expanded={false}
          isTarget={false}
          onToggleExpanded={() => undefined}
        />
      </ol>,
    );
    expect(container.querySelector('.tr-think')?.textContent).toBe('```not a fence```');
    expect(container.querySelector('.md-code')).toBeNull();
    rerender(
      <ol>
        <TranscriptRow
          unit={unitOf({ k: 'result', id: 'x', text: 'out <script>1</script>' })}
          hidden={false}
          expanded={false}
          isTarget={false}
          onToggleExpanded={() => undefined}
        />
      </ol>,
    );
    expect(container.querySelector('.tr-result')?.textContent).toBe('out <script>1</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('marks an error result with a badge that has text', () => {
    renderRow(unitOf({ k: 'result', id: 'x', text: 'boom', err: true }));
    expect(screen.getByText(msg('transcript.row.errorTag'))).toBeInTheDocument();
  });

  it('gives each role its own class, so the border follows the role and not a session state', () => {
    const kinds = [
      unitOf({ k: 'prompt', text: 'p' }),
      unitOf({ k: 'say', text: 's' }),
      unitOf({ k: 'think', text: 't' }),
      unitOf({ k: 'result', id: 'x', text: 'r' }),
    ];
    const classes = kinds.map((unit) => {
      const { container, unmount } = renderRow(unit);
      const className = container.querySelector('li')?.className ?? '';
      unmount();
      return className;
    });
    expect(classes[0]).toContain('tr--prompt');
    expect(classes[1]).toContain('tr--say');
    expect(classes[2]).toContain('tr--think');
    expect(classes[3]).toContain('tr--result');
    for (const className of classes) expect(className).not.toContain('tr--error');
  });

  it('adds the error class to an error result, so red is kept for errors', () => {
    const { container } = renderRow(unitOf({ k: 'result', id: 'x', text: 'boom', err: true }));
    expect(container.querySelector('li')).toHaveClass('tr--result', 'tr--error');
  });

  it('speaks Vietnamese in the label and the buttons', () => {
    renderWithIntl(
      <ol>
        <TranscriptRow
          unit={unitOf({ k: 'prompt', text: 'xin chao' })}
          hidden={false}
          expanded={false}
          isTarget={false}
          onToggleExpanded={() => undefined}
        />
      </ol>,
      { locale: 'vi' },
    );
    expect(screen.getByText(msg('transcript.kind.prompt', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('transcript.row.copyText', undefined, 'vi') })).toBeInTheDocument();
  });

  it('keeps hidden rows mounted with the hidden attribute', () => {
    const { container } = renderRow(unitOf({ k: 'say', text: 'x' }), { hidden: true });
    const row = container.querySelector('li');
    expect(row).toHaveAttribute('hidden');
    expect(row).toBeInTheDocument();
  });

  it('flags the jump target', () => {
    const { container } = renderRow(unitOf({ k: 'say', text: 'x' }), { isTarget: true });
    expect(container.querySelector('li')).toHaveClass('is-target');
  });

  it('clamps long text and reports the toggle by its clamp id', async () => {
    const onToggleExpanded = vi.fn();
    renderRow(unitOf({ k: 'say', text: 'w'.repeat(1700) }), { onToggleExpanded });
    await userEvent.setup().click(screen.getByRole('button', { name: msg('common.showMore') }));
    expect(onToggleExpanded).toHaveBeenCalledWith('e5-text', true);
  });

  it('has a Copy text button for the full text', () => {
    renderRow(unitOf({ k: 'say', text: 'copy me' }));
    expect(screen.getByRole('button', { name: msg('transcript.row.copyText') })).toBeInTheDocument();
  });

  it('shows new text when the entry at the same index is replaced (transcript reset)', () => {
    const onToggleExpanded = () => undefined;
    const { container, rerender } = renderRow(unitOf({ k: 'say', text: 'old text' }), { onToggleExpanded });
    expect(container).toHaveTextContent('old text');
    rerender(
      <ol>
        <TranscriptRow
          unit={unitOf({ k: 'say', text: 'fresh text' })}
          hidden={false}
          expanded={false}
          isTarget={false}
          onToggleExpanded={onToggleExpanded}
        />
      </ol>,
    );
    expect(container).toHaveTextContent('fresh text');
    expect(container).not.toHaveTextContent('old text');
  });

  it('does not re-render for a new unit object that wraps the same entry', () => {
    const first = unitOf({ k: 'say', text: 'same' });
    const onToggleExpanded = () => undefined;
    const props = { hidden: false, expanded: false, isTarget: false, onToggleExpanded };
    const { rerender } = renderWithIntl(
      <ol>
        <TranscriptRow unit={first} {...props} />
      </ol>,
    );
    const before = markdownRenders.count;
    rerender(
      <ol>
        <TranscriptRow unit={{ ...first }} {...props} />
      </ol>,
    );
    expect(markdownRenders.count).toBe(before);
  });
});

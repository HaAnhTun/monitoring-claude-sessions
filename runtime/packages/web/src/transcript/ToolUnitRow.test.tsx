import type { TranscriptEntry } from '@mcs/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type * as ClampedModule from '../components/ClampedText.tsx';

import { pairEvents, type Unit } from '../lib/timeline-model.ts';
import { FIXTURE_NOW_MS, iso } from '../test/fixtures/index.ts';
import { prettyInput, ToolUnitRow } from './ToolUnitRow.tsx';

const clampRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/ClampedText.tsx', async (importOriginal) => {
  const real = await importOriginal<typeof ClampedModule>();
  return {
    ...real,
    ClampedText: (props: Parameters<typeof real.ClampedText>[0]) => {
      clampRenders.count += 1;
      return <real.ClampedText {...props} />;
    },
  };
});

function tool(extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    i: 2,
    t: iso(-10),
    k: 'tool',
    id: 'toolu_1',
    name: 'Bash',
    summary: 'ls -la',
    input: '{"command":"ls"}',
    ...extra,
  };
}
function result(extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { i: 3, t: iso(-7), k: 'result', id: 'toolu_1', text: 'file-a\nfile-b', ...extra };
}
function unitsOf(...entries: TranscriptEntry[]): Unit {
  const unit = pairEvents(entries)[0];
  if (unit === undefined) throw new Error('fixture produced no unit');
  return unit;
}

type Props = Parameters<typeof ToolUnitRow>[0];
const noop = (): void => undefined;
function propsOf(unit: Unit, props: Partial<Props> = {}): Props {
  return {
    unit,
    hidden: false,
    open: false,
    onOpenChange: noop,
    expandedInput: false,
    expandedResult: false,
    onToggleExpanded: noop,
    hideResult: false,
    isTarget: false,
    nowMs: FIXTURE_NOW_MS,
    ...props,
  };
}
function renderRow(unit: Unit, props: Partial<Props> = {}) {
  return render(
    <ol>
      <ToolUnitRow {...propsOf(unit, props)} />
    </ol>,
  );
}

describe('ToolUnitRow', () => {
  it('is a details element with name, one-line summary, index and time in the summary line', () => {
    const { container } = renderRow(unitsOf(tool(), result()));
    const details = container.querySelector('li > details');
    expect(details).not.toBeNull();
    const summary = details?.querySelector('summary');
    expect(summary).toHaveTextContent('Bash');
    expect(summary).toHaveTextContent('ls -la');
    expect(summary).toHaveTextContent('#2');
    expect(container.querySelector('li')).toHaveAttribute('data-row-key', 'e2');
  });

  it('shows ok with the duration for a completed call', () => {
    renderRow(unitsOf(tool(), result()));
    expect(screen.getByText('ok 3s')).toBeInTheDocument();
  });

  it('shows failed with the duration when the result is an error', () => {
    renderRow(unitsOf(tool(), result({ err: true, text: 'nope' })), { open: true });
    expect(screen.getByText('failed 3s')).toBeInTheDocument();
    expect(screen.getByText('Result: error')).toBeInTheDocument();
  });

  it('shows running with the elapsed time for a call without a result', () => {
    renderRow(unitsOf(tool()), { nowMs: FIXTURE_NOW_MS - 10_000 + 12_000 });
    expect(screen.getByText('running 12s')).toBeInTheDocument();
  });

  it('follows the open prop and reports user toggles by row key', () => {
    const onOpenChange = vi.fn();
    const { container, rerender } = renderRow(unitsOf(tool(), result()), { onOpenChange });
    const details = container.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    if (details === null) throw new Error('no details');
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(onOpenChange).toHaveBeenCalledWith('e2', true);
    rerender(
      <ol>
        <ToolUnitRow
          unit={unitsOf(tool(), result())}
          hidden={false}
          open
          onOpenChange={onOpenChange}
          expandedInput={false}
          expandedResult={false}
          onToggleExpanded={() => undefined}
          hideResult={false}
          isTarget={false}
          nowMs={FIXTURE_NOW_MS}
        />
      </ol>,
    );
    expect(container.querySelector('details')).toHaveAttribute('open');
  });

  it('pretty-prints JSON input and falls back to the raw text', () => {
    const { container, rerender } = renderRow(unitsOf(tool(), result()), { open: true });
    expect(container.querySelector('.tu-input')?.textContent).toBe('{\n  "command": "ls"\n}');
    rerender(
      <ol>
        <ToolUnitRow
          unit={unitsOf(tool({ input: '{"cut": "off' }), result())}
          hidden={false}
          open
          onOpenChange={() => undefined}
          expandedInput={false}
          expandedResult={false}
          onToggleExpanded={() => undefined}
          hideResult={false}
          isTarget={false}
          nowMs={FIXTURE_NOW_MS}
        />
      </ol>,
    );
    expect(container.querySelector('.tu-input')?.textContent).toBe('{"cut": "off');
  });

  it('labels the result block and has copy buttons for input and tool id', () => {
    renderRow(unitsOf(tool(), result()), { open: true });
    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy tool input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy tool id' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy event index' })).toBeInTheDocument();
  });

  it('adds hide-result when the Results kind is off', () => {
    const { container } = renderRow(unitsOf(tool(), result()), { hideResult: true });
    expect(container.querySelector('details')).toHaveClass('hide-result');
  });

  it('renders hostile input and output as text', () => {
    const { container } = renderRow(
      unitsOf(tool({ input: '<img src=x onerror=alert(1)>' }), result({ text: '<script>alert(1)</script>' })),
      { open: true },
    );
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps hidden rows mounted and flags the target', () => {
    const { container } = renderRow(unitsOf(tool(), result()), { hidden: true, isTarget: true });
    const row = container.querySelector('li');
    expect(row).toHaveAttribute('hidden');
    expect(row).toHaveClass('is-target');
  });

  it('shows the new result when the entries at the same indices are replaced (transcript reset)', () => {
    const { container, rerender } = renderRow(unitsOf(tool(), result({ text: 'old output' })), { open: true });
    expect(container).toHaveTextContent('old output');
    rerender(
      <ol>
        <ToolUnitRow {...propsOf(unitsOf(tool(), result({ text: 'fresh output' })), { open: true })} />
      </ol>,
    );
    expect(container).toHaveTextContent('fresh output');
    expect(container).not.toHaveTextContent('old output');
  });

  it('does not re-render for a new unit object that wraps the same entries', () => {
    const first = unitsOf(tool(), result());
    const { rerender } = renderRow(first, { open: true });
    const before = clampRenders.count;
    rerender(
      <ol>
        <ToolUnitRow {...propsOf({ ...first }, { open: true })} />
      </ol>,
    );
    expect(clampRenders.count).toBe(before);
  });

  it('pretty-prints JSON input but keeps the raw text when a number would be rounded', () => {
    expect(prettyInput('{"a":1}')).toBe(['{', '  "a": 1', '}'].join(String.fromCharCode(10)));
    expect(prettyInput('not json')).toBe('not json');
    expect(prettyInput('{"id":12345678901234567890}')).toBe('{"id":12345678901234567890}');
  });
});

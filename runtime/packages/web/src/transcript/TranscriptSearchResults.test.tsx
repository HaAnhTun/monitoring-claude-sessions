import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../data/api-errors.ts';
import { iso, makeTranscriptSearch } from '../test/fixtures/index.ts';
import { TranscriptSearchResults } from './TranscriptSearchResults.tsx';

const MATCHES = [
  { i: 12, k: 'say' as const, t: iso(0), name: null, snippet: 'we found the Needle in the haystack', offset: 100 },
  { i: 30, k: 'tool' as const, t: iso(60), name: 'Bash', snippet: 'run needle --now', offset: 900 },
];

function search(extra: Parameters<typeof makeTranscriptSearch>[0] = {}) {
  return makeTranscriptSearch({ matches: MATCHES, count: 2, ...extra });
}

function renderResults(props: Partial<Parameters<typeof TranscriptSearchResults>[0]> = {}) {
  const merged = {
    status: 'ready' as const,
    response: search(),
    error: null,
    onJump: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  render(<TranscriptSearchResults {...merged} />);
  return merged;
}

describe('TranscriptSearchResults', () => {
  it('lists index, time, kind, name and snippet of each match', () => {
    renderResults();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('#12');
    expect(rows[0]).toHaveTextContent('12:00:00');
    expect(rows[0]).toHaveTextContent('Claude');
    expect(rows[1]).toHaveTextContent('Tool Bash');
  });

  it('highlights matches with mark elements built from text segments', () => {
    renderResults();
    const marks = Array.from(document.querySelectorAll('mark')).map((m) => m.textContent);
    expect(marks).toEqual(['Needle', 'needle']);
  });

  it('shows hostile snippets as text', () => {
    renderResults({
      response: search({
        matches: [{ ...MATCHES[0]!, snippet: '<img src=x onerror=alert(1)> needle' }],
        count: 1,
      }),
    });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it('jumps to the entry of a clicked row', async () => {
    const props = renderResults();
    await userEvent.setup().click(screen.getAllByRole('button', { name: /^Jump to #/ })[1]!);
    expect(props.onJump).toHaveBeenCalledWith(30);
  });

  it('notes a truncated result', () => {
    renderResults({ response: search({ truncated: true }) });
    expect(screen.getByText('Showing the first 2 matches')).toBeInTheDocument();
  });

  it('never claims the whole transcript was searched when coverage is incomplete', () => {
    renderResults({
      response: search({
        complete: false,
        partial: true,
        coverage: { ...makeTranscriptSearch().coverage, complete: false, note: 'Searched 1 of 2 files.' },
      }),
    });
    expect(screen.getByText('Searched 1 of 2 files.')).toBeInTheDocument();
    expect(screen.getByText('Not every part of the transcript was searched')).toBeInTheDocument();
  });

  it('shows the coverage note without a warning when complete', () => {
    renderResults();
    expect(screen.getByText('FIXTURE coverage note')).toBeInTheDocument();
    expect(screen.queryByText('Not every part of the transcript was searched')).toBeNull();
  });

  it('says when there is no match', () => {
    renderResults({ response: search({ matches: [], count: 0 }) });
    expect(screen.getByText('No matches in the searched part of the transcript.')).toBeInTheDocument();
  });

  it('shows a busy message for search_busy', () => {
    const error = new ApiError('busy', {
      kind: 'http',
      status: 429,
      code: 'search_busy',
      endpoint: 'transcriptSearch',
      requestId: null,
    });
    renderResults({ status: 'error', response: null, error });
    expect(screen.getByText('Another search is running; try again in a moment')).toBeInTheDocument();
  });

  it('shows the message of other failures and a loading state', () => {
    const error = new ApiError('Monitor error (500)', {
      kind: 'http',
      status: 500,
      code: null,
      endpoint: 'transcriptSearch',
      requestId: null,
    });
    const { rerender } = render(
      <TranscriptSearchResults status="error" response={null} error={error} onJump={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Search failed: Monitor error (500)')).toBeInTheDocument();
    rerender(
      <TranscriptSearchResults status="loading" response={null} error={null} onJump={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Searching the transcript...')).toBeInTheDocument();
  });

  it('closes on request', async () => {
    const props = renderResults();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close search results' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

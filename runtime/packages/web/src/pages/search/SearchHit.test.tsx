import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeInstanceSearchMatch } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { hitHref, SearchHit } from './SearchHit.tsx';

function renderHit(snippet: string, q: string, over: Parameters<typeof makeInstanceSearchMatch>[0] = {}) {
  const match = makeInstanceSearchMatch({ snippet, ...over });
  return {
    match,
    ...renderWithIntl(
      <ul>
        <SearchHit match={match} q={q} />
      </ul>,
    ),
  };
}

describe('SearchHit', () => {
  it('links to the transcript of the session at the matching entry', () => {
    const { match } = renderHit('FIXTURE a needle', 'needle', { i: 12 });
    expect(screen.getByRole('link')).toHaveAttribute('href', `/sessions/${match.sessionId}?tab=transcript&i=12`);
  });

  it('adds the agent to the link when the match is in a subagent', () => {
    const match = makeInstanceSearchMatch({ agentId: 'agentqa001', i: 3 });
    expect(hitHref(match)).toBe(`/sessions/${match.sessionId}?tab=transcript&agent=agentqa001&i=3`);
  });

  it('shows the kind, the agent, the entry number and the time', () => {
    renderHit('FIXTURE a needle', 'needle', { k: 'tool', name: 'Bash', i: 7, agentId: 'agentqa001' });
    expect(screen.getByText(`${msg('transcript.kind.tool')} Bash`)).toBeInTheDocument();
    expect(screen.getByText(msg('search.hit.agentSub', { id: 'agentqa001' }))).toBeInTheDocument();
    expect(screen.getByText(msg('search.hit.entry', { index: '7' }))).toBeInTheDocument();
  });

  it('names the main agent', () => {
    renderHit('FIXTURE a needle', 'needle');
    expect(screen.getByText(msg('search.hit.agentMain'))).toBeInTheDocument();
  });

  it('marks the searched text in the snippet, whatever its case', () => {
    const { container } = renderHit('FIXTURE a Needle and a NEEDLE', 'needle');
    const marks = [...container.querySelectorAll('mark')].map((mark) => mark.textContent);
    expect(marks).toEqual(['Needle', 'NEEDLE']);
  });

  it('draws a hostile snippet as text, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script> needle <b>bold</b>';
    const { container } = renderHit(hostile, 'needle');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('.search-hit__snippet')).toHaveTextContent(hostile);
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });

  it('does not break on a searched text with pattern characters', () => {
    const { container } = renderHit('FIXTURE a (b+c)* d', '(b+c)*');
    expect(container.querySelector('mark')).toHaveTextContent('(b+c)*');
  });
});

import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeSessionDetail, makeUsage } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionStats } from './SessionStats.tsx';

const HREF = '/sessions/abc?tab=errors';

function tile(name: string): HTMLElement {
  const term = screen.getByText(name, { selector: 'dt' });
  const box = term.closest('.session-stat');
  if (!(box instanceof HTMLElement)) throw new Error(`no tile for ${name}`);
  return box;
}

describe('SessionStats', () => {
  it('has the four tiles Active span, Last activity, Tokens and Errors, in that order', () => {
    renderWithIntl(<SessionStats session={makeSessionDetail()} errors={null} errorsHref={HREF} />);
    const group = screen.getByRole('group', { name: msg('detail.stats.label') });
    const terms = within(group)
      .getAllByRole('term')
      .map((term) => term.textContent)
      .slice(0, 2);
    expect(terms).toEqual([msg('detail.stats.activeSpan'), msg('detail.stats.lastActivity')]);
    expect(tile(msg('detail.stats.tokens'))).toBeInTheDocument();
    expect(tile(msg('detail.stats.errors'))).toBeInTheDocument();
  });

  it('shows the active span as a duration and says when the session started', () => {
    renderWithIntl(
      <SessionStats session={makeSessionDetail({ durationMs: 125_000 })} errors={null} errorsHref={HREF} />,
    );
    const box = tile(msg('detail.stats.activeSpan'));
    expect(box).toHaveTextContent('2m 5s');
    expect(box.querySelector('.session-stat__sub')).toHaveTextContent(/^Started /);
    expect(within(box).getByText(msg('detail.stats.activeSpan'))).toHaveAttribute(
      'title',
      msg('detail.stats.activeSpan.tip'),
    );
  });

  it('shows the last activity as an age', () => {
    renderWithIntl(<SessionStats session={makeSessionDetail()} errors={null} errorsHref={HREF} />);
    expect(tile(msg('detail.stats.lastActivity')).querySelector('time')).not.toBeNull();
  });

  it('shows Output and Input (new) in the tokens tile, not Cache read, and notes the subagents', () => {
    renderWithIntl(
      <SessionStats
        session={makeSessionDetail({
          usageInclSubagents: makeUsage({ input: 1000, cacheCreation: 500, output: 2500, cacheRead: 3_000_000 }),
        })}
        errors={null}
        errorsHref={HREF}
      />,
    );
    const box = tile(msg('detail.stats.tokens'));
    const terms = within(box)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual([msg('detail.stats.tokens'), msg('tokens.output'), msg('tokens.inputNew')]);
    expect(box).toHaveTextContent('2.5K');
    expect(box).toHaveTextContent('1.5K');
    expect(box).not.toHaveTextContent('3M');
    expect(within(box).getByText(msg('tokens.inclSubagents'))).toBeInTheDocument();
  });

  it('says "not available" for token numbers the monitor does not have, never 0', () => {
    renderWithIntl(
      <SessionStats
        session={makeSessionDetail({ usageInclSubagents: makeUsage({ completeness: 'unavailable' }) })}
        errors={null}
        errorsHref={HREF}
      />,
    );
    const box = tile(msg('detail.stats.tokens'));
    expect(within(box).getAllByText(msg('tokens.notAvailable')).length).toBeGreaterThan(0);
    expect(box).not.toHaveTextContent(/\b0\b/);
  });

  it('shows the error count with no link and no split for a session without errors', () => {
    renderWithIntl(<SessionStats session={makeSessionDetail({ errorCount: 0 })} errors={null} errorsHref={HREF} />);
    const box = tile(msg('detail.stats.errors'));
    expect(box.querySelector('.session-stat__value')).toHaveTextContent('0');
    expect(within(box).queryByRole('link')).toBeNull();
  });

  it('breaks the error count down into this agent and the subagents, with a link to the Errors view', () => {
    renderWithIntl(
      <SessionStats
        session={makeSessionDetail({ errorCount: 1 })}
        errors={{ thisAgent: 0, subagents: 1 }}
        errorsHref={HREF}
      />,
    );
    const box = tile(msg('detail.stats.errors'));
    expect(box.querySelector('.session-stat__value')).toHaveTextContent('1');
    expect(
      within(box).getByText(msg('transcript.errors.breakdown', { thisAgent: 0, subagents: 1 })),
    ).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: msg('transcript.errors.viewAll') })).toHaveAttribute('href', HREF);
  });

  it("has no split when every error is the main agent's own", () => {
    renderWithIntl(
      <SessionStats
        session={makeSessionDetail({ errorCount: 2 })}
        errors={{ thisAgent: 2, subagents: 0 }}
        errorsHref={HREF}
      />,
    );
    const box = tile(msg('detail.stats.errors'));
    expect(box).not.toHaveTextContent(msg('transcript.errors.breakdown', { thisAgent: 2, subagents: 0 }));
    expect(within(box).getByRole('link')).toBeInTheDocument();
  });

  it('counts warnings under the errors and offers the link for warnings alone', () => {
    renderWithIntl(
      <SessionStats session={makeSessionDetail({ errorCount: 0, warningCount: 3 })} errors={null} errorsHref={HREF} />,
    );
    const box = tile(msg('detail.stats.errors'));
    expect(within(box).getByText(msg('detail.stats.warnings', { count: 3 }))).toBeInTheDocument();
    expect(within(box).getByRole('link')).toBeInTheDocument();
  });

  it('is worded and formatted in Vietnamese', () => {
    renderWithIntl(
      <SessionStats
        session={makeSessionDetail({ errorCount: 1 })}
        errors={{ thisAgent: 0, subagents: 1 }}
        errorsHref={HREF}
      />,
      { locale: 'vi' },
    );
    expect(screen.getByRole('group', { name: msg('detail.stats.label', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('detail.stats.activeSpan', undefined, 'vi'))).toBeInTheDocument();
    expect(
      screen.getByText(msg('transcript.errors.breakdown', { thisAgent: 0, subagents: 1 }, 'vi')),
    ).toBeInTheDocument();
  });
});

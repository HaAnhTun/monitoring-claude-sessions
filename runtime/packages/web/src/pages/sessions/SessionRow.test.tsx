import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeSession, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { modelLineOf, modelsDiffer, SessionRow } from './SessionRow.tsx';

describe('SessionRow', () => {
  it('shows the label and the first eight characters of the id, with the whole id as its title', () => {
    renderWithIntl(<SessionRow session={makeSession({ id: sessionId(7), label: 'FIXTURE build step' })} />);
    expect(screen.getByText('FIXTURE build step')).toBeInTheDocument();
    const id = screen.getByTitle(sessionId(7));
    expect(id).toHaveTextContent(sessionId(7).slice(0, 8));
    expect(id.textContent).toHaveLength(8);
  });

  it('keeps the whole label as a tooltip, for a label the cell has to cut', () => {
    renderWithIntl(<SessionRow session={makeSession({ label: 'FIXTURE a very long label of a session' })} />);
    expect(screen.getByText('FIXTURE a very long label of a session')).toHaveAttribute(
      'title',
      'FIXTURE a very long label of a session',
    );
  });

  it('draws the model on its own line only when asked to', () => {
    const session = makeSession({ models: ['fixture-model-a', 'fixture-model-b'] });
    const { rerender } = renderWithIntl(<SessionRow session={session} />);
    expect(screen.queryByText('fixture-model-a, fixture-model-b')).toBeNull();
    rerender(<SessionRow session={session} showModel />);
    expect(screen.getByText('fixture-model-a, fixture-model-b')).toBeInTheDocument();
  });

  it('draws no model line for a session without a model', () => {
    const { container } = renderWithIntl(
      <SessionRow session={makeSession({ models: [], lastModel: null })} showModel />,
    );
    expect(container.querySelector('.session-cell__model')).toBeNull();
  });

  it('tags a session that no project rule matched, in the language of the page', () => {
    const session = makeSession({ matched: false });
    const { unmount } = renderWithIntl(<SessionRow session={session} />);
    const tag = screen.getByText(msg('sessions.session.notInList'));
    expect(tag.closest('[title]')).toHaveAttribute('title', msg('sessions.session.notInList.tip'));
    unmount();
    renderWithIntl(<SessionRow session={session} />, { locale: 'vi' });
    expect(screen.getByText(msg('sessions.session.notInList', undefined, 'vi'))).toBeInTheDocument();
  });

  it('has no tag for a matched session', () => {
    renderWithIntl(<SessionRow session={makeSession({ matched: true })} />);
    expect(screen.queryByText(msg('sessions.session.notInList'))).toBeNull();
  });
});

describe('modelLineOf and modelsDiffer', () => {
  const a = makeSession({ id: sessionId(1), models: ['m1'] });
  const b = makeSession({ id: sessionId(2), models: ['m2'] });

  it('reads the models, else the last model, else nothing', () => {
    expect(modelLineOf(makeSession({ models: ['m1', 'm2'] }))).toBe('m1, m2');
    expect(modelLineOf(makeSession({ models: [], lastModel: 'm3' }))).toBe('m3');
    expect(modelLineOf(makeSession({ models: [], lastModel: null }))).toBe('');
  });

  it('is true only when two sessions use another model', () => {
    expect(modelsDiffer([a, a])).toBe(false);
    expect(modelsDiffer([a])).toBe(false);
    expect(modelsDiffer([])).toBe(false);
    expect(modelsDiffer([a, b])).toBe(true);
    expect(modelsDiffer([a, makeSession({ models: [], lastModel: null })])).toBe(true);
  });
});

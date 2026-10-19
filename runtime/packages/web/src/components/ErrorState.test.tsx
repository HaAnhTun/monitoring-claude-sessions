import type { ErrorCode } from '@mcs/shared';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiErrorMessage, handlingFor, type ApiErrorKind } from '../data/api-errors.ts';
import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { createCatalogues, createT } from '../i18n/translate.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { ErrorState } from './ErrorState.tsx';

afterEach(() => {
  vi.useRealTimers();
});

const SOURCE = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
const DIAGNOSTIC = 'English diagnostic that the UI must not show';

function failure(status: number, code: ErrorCode | null, serverMessage = ''): ApiError {
  return new ApiError(DIAGNOSTIC, {
    kind: 'http',
    status,
    code,
    endpoint: 'sessions',
    requestId: 'r-0123456789ab',
    ...(serverMessage === '' ? {} : { serverMessage }),
  });
}

function transport(kind: ApiErrorKind, timeoutMs?: number): ApiError {
  return new ApiError(DIAGNOSTIC, {
    kind,
    status: 0,
    code: null,
    endpoint: 'sessions',
    requestId: null,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('ErrorState', () => {
  it('announces a page-size load failure as an alert with the subject and the reason', () => {
    renderWithIntl(
      <ErrorState kind="load" size="page" subjectKey="error.subject.sessions" error={new Error('refused')} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      msg('error.loadDetail', { subject: msg('error.subject.sessions'), detail: 'refused' }),
    );
  });

  it('keeps the V3 text for a subject given as a plain string', () => {
    renderWithIntl(<ErrorState kind="load" subject="more sessions" error={new Error('x')} />);
    expect(screen.getByRole('status')).toHaveTextContent('Could not load more sessions: x. Retrying automatically.');
  });

  it('says what could not be loaded without a reason when there is none', () => {
    renderWithIntl(<ErrorState kind="load" />);
    expect(screen.getByRole('status')).toHaveTextContent(msg('error.load', { subject: msg('error.subject.data') }));
  });

  it.each([
    ['load', 'block'],
    ['refresh', 'page'],
    ['not-found', 'page'],
    ['crash', 'page'],
    ['contract', 'page'],
  ] as const)('uses a status region (not an alert) for kind %s at size %s', (kind, size) => {
    renderWithIntl(<ErrorState kind={kind} size={size} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the retry button only with a callback and calls it', async () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithIntl(<ErrorState kind="load" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ErrorState kind="load" onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: msg('common.retryNow') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says how old the kept data is for a refresh failure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    renderWithIntl(
      <ErrorState
        kind="refresh"
        subjectKey="error.subject.sessions"
        error={new Error('timeout')}
        lastGoodAt={Date.parse('2026-01-01T00:00:48Z')}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('error.refreshDetail', { subject: msg('error.subject.sessions'), detail: 'timeout', age: '12s ago' }),
    );
  });

  it('says "earlier" when the age of the kept data is not known', () => {
    renderWithIntl(<ErrorState kind="refresh" lastGoodAt={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('error.refresh', { subject: msg('error.subject.data'), age: msg('time.earlier') }),
    );
  });

  it('explains an unknown session', () => {
    renderWithIntl(<ErrorState kind="not-found" />);
    expect(screen.getByText(msg('error.sessionNotFound'))).toBeInTheDocument();
  });

  it('offers Reload view for a crash and keeps extra actions', async () => {
    const onRetry = vi.fn();
    renderWithIntl(
      <ErrorState kind="crash" onRetry={onRetry}>
        <button type="button">{msg('common.copyErrorDetails')}</button>
      </ErrorState>,
    );
    expect(screen.getByText(msg('common.viewFailed'))).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: msg('common.reloadView') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: msg('common.copyErrorDetails') })).toBeInTheDocument();
  });

  it('names a contract failure without hiding the reason', () => {
    renderWithIntl(<ErrorState kind="contract" error={new Error('field sessions[0].state is invalid')} />);
    expect(screen.getByRole('status')).toHaveTextContent('field sessions[0].state is invalid');
  });

  it('marks the inline size for the layout', () => {
    const { container } = renderWithIntl(<ErrorState kind="load" size="inline" />);
    expect(container.firstElementChild).toHaveClass('state--inline');
  });

  describe('the reason of every ApiError comes from the catalogue, never from the English diagnostic', () => {
    const cases: [string, ApiError][] = [
      ['network', transport('network')],
      ['timeout', transport('timeout', 8000)],
      ['timeout without a duration', transport('timeout')],
      ['parse', transport('parse')],
      ['contract', transport('contract')],
      ['aborted', transport('aborted')],
      ['403', failure(403, 'host_not_allowed')],
      ['404', failure(404, 'session_not_found', 'FIXTURE session')],
      ['410', failure(410, 'transcript_gone')],
      ['429', failure(429, 'search_busy')],
      ['500', failure(500, 'internal_error', 'kaput')],
      ['503', failure(503, 'db_busy')],
      ['rejected filter', failure(400, 'query_too_short', 'q is too short')],
      ['unknown code', failure(409, 'instance_mismatch')],
    ];

    it.each(cases)('%s, in English and in Vietnamese', (_name, error) => {
      for (const locale of ['en', 'vi'] as const) {
        const { unmount } = renderWithIntl(
          <ErrorState kind="load" subjectKey="error.subject.sessions" error={error} />,
          { locale },
        );
        const reason = apiErrorMessage(error).text(createT(locale, SOURCE));
        const expected = msg(
          'error.loadDetail',
          { subject: msg('error.subject.sessions', undefined, locale), detail: reason },
          locale,
        );
        expect(screen.getByRole('status')).toHaveTextContent(expected);
        expect(screen.getByRole('status')).not.toHaveTextContent(DIAGNOSTIC);
        unmount();
      }
    });

    it('the 404, 410, 429, 503 and rejected-filter handlings are worded for the screen too', () => {
      for (const error of [
        failure(404, 'session_not_found'),
        failure(410, 'transcript_gone'),
        failure(429, 'export_busy'),
        failure(503, 'shutting_down'),
        failure(400, 'range_invalid', 'bad range'),
      ]) {
        const handling = handlingFor(error);
        for (const locale of ['en', 'vi'] as const) {
          const text = handling.text(createT(locale, SOURCE));
          expect(text, handling.action).not.toBe('');
          expect(text, handling.action).not.toContain('{');
        }
      }
    });
  });

  it('switches language while it is on screen', () => {
    const error = failure(500, 'internal_error', 'kaput');
    const { prefsStore } = renderWithIntl(
      <ErrorState kind="load" subjectKey="error.subject.sessions" error={error} onRetry={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    act(() => {
      prefsStore.setPref('locale', 'vi');
    });
    expect(screen.getByRole('button', { name: msg('common.retryNow', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(msg('error.subject.sessions', undefined, 'vi'));
    expect(screen.getByRole('status')).not.toHaveTextContent(msg('error.subject.sessions'));
  });
});

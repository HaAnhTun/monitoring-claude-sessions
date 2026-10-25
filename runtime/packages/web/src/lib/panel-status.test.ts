import type { PanelResponse } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../data/api-errors.ts';
import { makePanelResponse } from '../test/fixtures/panels.ts';
import { isPanelDisabled, toPanelViewStatus, type PanelQueryState } from './panel-status.ts';

const NOW = Date.parse('2026-10-12T12:00:10.000Z');
const GENERATED = '2026-10-12T12:00:08.000Z';
const STALE_AFTER = 30_000;

function state(data: PanelResponse | undefined, extra: Partial<Omit<PanelQueryState, 'data'>> = {}): PanelQueryState {
  return { data, error: null, isFetching: false, dataUpdatedAt: data === undefined ? 0 : NOW - 2000, ...extra };
}

function httpError(status: number, code: ApiError['info']['code'], message: string): ApiError {
  return new ApiError(message, { kind: 'http', status, code, endpoint: 'panel.git', requestId: null });
}

describe('toPanelViewStatus (04 4.4.1)', () => {
  it('is loading while there is no data and a fetch is running', () => {
    expect(toPanelViewStatus(state(undefined, { isFetching: true }), NOW, STALE_AFTER)).toEqual({ kind: 'loading' });
  });

  it('is loading before the first fetch starts (a collapsed or disabled query)', () => {
    expect(toPanelViewStatus(state(undefined), NOW, STALE_AFTER)).toEqual({ kind: 'loading' });
  });

  it('maps an ok response to ok with asOf from generatedAt', () => {
    const data = makePanelResponse('git', { status: 'ok', generatedAt: GENERATED });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER)).toEqual({ kind: 'ok', asOf: Date.parse(GENERATED) });
  });

  it('maps a partial response to partial with one note per source that is not ok', () => {
    const data = makePanelResponse('machine', {
      status: 'partial',
      generatedAt: GENERATED,
      sources: [
        { source: 'memory', status: 'ok', sampledAt: GENERATED, message: null },
        { source: 'processes', status: 'pending', sampledAt: '2026-10-12T12:00:01.000Z', message: null },
        { source: 'docker', status: 'unavailable', sampledAt: null, message: 'docker is not running' },
        { source: 'cpu', status: 'error', sampledAt: '2026-10-12T12:00:05.000Z', message: 'sampler failed' },
      ],
    });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER)).toEqual({
      kind: 'partial',
      asOf: Date.parse(GENERATED),
      notes: [
        'processes: pending, as of 12:00:01',
        'docker: unavailable, docker is not running',
        'cpu: error, sampler failed, as of 12:00:05',
      ],
    });
  });

  it('does not report a source that the configuration switched off', () => {
    const data = makePanelResponse('git', {
      status: 'partial',
      generatedAt: GENERATED,
      sources: [
        { source: 'git.status', status: 'ok', sampledAt: GENERATED, message: null },
        { source: 'git.log', status: 'pending', sampledAt: null, message: null },
        { source: 'stopFile', status: 'disabled', sampledAt: null, message: null },
      ],
    });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER)).toEqual({
      kind: 'partial',
      asOf: Date.parse(GENERATED),
      notes: ['git.log: pending'],
    });
  });

  it('maps status error with data null to error using the first source message', () => {
    const data = makePanelResponse('git', {
      status: 'error',
      generatedAt: GENERATED,
      data: null,
      sources: [
        { source: 'git.status', status: 'error', sampledAt: null, message: null },
        { source: 'git.log', status: 'error', sampledAt: null, message: 'git is not installed' },
      ],
    });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER)).toEqual({
      kind: 'error',
      message: 'git is not installed',
      lastGoodAt: null,
    });
  });

  it('uses a fixed message when no source says anything', () => {
    const data = makePanelResponse('ledger', { status: 'error', generatedAt: GENERATED, data: null, sources: [] });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER)).toMatchObject({
      kind: 'error',
      message: 'No source produced data',
    });
  });

  it('maps a query error without data to error with the failure text and no last good time', () => {
    const error = httpError(500, 'internal_error', 'Monitor error (500): kaput');
    expect(toPanelViewStatus(state(undefined, { error }), NOW, STALE_AFTER)).toEqual({
      kind: 'error',
      message: 'Monitor error (500): kaput',
      lastGoodAt: null,
    });
  });

  it('keeps the last good data time when a later refresh fails (the data stays rendered)', () => {
    const data = makePanelResponse('git', { status: 'ok', generatedAt: GENERATED });
    const error = httpError(503, 'db_busy', 'Monitor error (503)');
    expect(toPanelViewStatus(state(data, { error, dataUpdatedAt: NOW - 7000 }), NOW, STALE_AFTER)).toEqual({
      kind: 'error',
      message: 'Monitor error (503)',
      lastGoodAt: NOW - 7000,
    });
  });

  it('maps 404 panel_disabled to an error the page uses to remove the panel', () => {
    const error = httpError(404, 'panel_disabled', 'Not found: panel disabled');
    const status = toPanelViewStatus(state(undefined, { error }), NOW, STALE_AFTER);
    expect(status).toMatchObject({ kind: 'error', lastGoodAt: null });
    expect(isPanelDisabled(error)).toBe(true);
  });

  it('isPanelDisabled is false for other failures and for non-API errors', () => {
    expect(isPanelDisabled(httpError(404, 'session_not_found', 'x'))).toBe(false);
    expect(isPanelDisabled(httpError(500, 'internal_error', 'x'))).toBe(false);
    expect(isPanelDisabled(new Error('boom'))).toBe(false);
    expect(isPanelDisabled(null)).toBe(false);
  });

  it('turns ok and partial into stale after staleAfterMs', () => {
    const old = '2026-10-12T11:59:00.000Z';
    const ok = makePanelResponse('git', { status: 'ok', generatedAt: old });
    expect(toPanelViewStatus(state(ok), NOW, STALE_AFTER)).toEqual({ kind: 'stale', asOf: Date.parse(old) });
    const partial = makePanelResponse('machine', {
      status: 'partial',
      generatedAt: old,
      sources: [{ source: 'docker', status: 'pending', sampledAt: null, message: null }],
    });
    expect(toPanelViewStatus(state(partial), NOW, STALE_AFTER)).toEqual({ kind: 'stale', asOf: Date.parse(old) });
  });

  it('is not stale exactly at the limit', () => {
    const edge = new Date(NOW - STALE_AFTER).toISOString();
    const data = makePanelResponse('git', { status: 'ok', generatedAt: edge });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER).kind).toBe('ok');
  });

  it('never marks an error as stale', () => {
    const data = makePanelResponse('git', {
      status: 'error',
      generatedAt: '2026-10-12T11:00:00.000Z',
      data: null,
      sources: [],
    });
    expect(toPanelViewStatus(state(data), NOW, STALE_AFTER).kind).toBe('error');
  });

  it('treats an unparsable generatedAt as asOf 0, which is stale rather than a crash', () => {
    const data = makePanelResponse('git', { status: 'ok', generatedAt: GENERATED });
    const broken = { ...data, generatedAt: 'not a time' };
    expect(toPanelViewStatus(state(broken), NOW, STALE_AFTER)).toEqual({ kind: 'stale', asOf: 0 });
  });
});

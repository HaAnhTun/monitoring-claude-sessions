import { ERROR_CODES, ERROR_HTTP_STATUS, type ErrorCode } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { createCatalogues, createT } from '../i18n/translate.ts';
import { msg } from '../test/msg.ts';
import { ApiError, apiErrorMessage, describeApiError, handlingFor, type ApiErrorKind } from './api-errors.ts';

const source = createCatalogues({ initial: { en: enMessages, vi: viMessages } });
const tEn = createT('en', source);
const tVi = createT('vi', source);

function http(
  status: number,
  code: ErrorCode | null,
  serverMessage = 'server text',
  requestId: string | null = 'r-0123456789ab',
): ApiError {
  return new ApiError('diagnostic', {
    kind: 'http',
    status,
    code,
    endpoint: 'sessions',
    requestId,
    ...(serverMessage === '' ? {} : { serverMessage }),
  });
}

function transport(kind: ApiErrorKind, extra: Partial<ApiError['info']> = {}): ApiError {
  return new ApiError('diagnostic', { kind, status: 0, code: null, endpoint: 'health', requestId: null, ...extra });
}

describe('apiErrorMessage: the catalogue key and arguments of every failure', () => {
  it('names a timeout with the seconds that were waited, or without them', () => {
    expect(apiErrorMessage(transport('timeout', { timeoutMs: 8000 }))).toMatchObject({
      messageKey: 'error.api.timeout',
      args: { seconds: 8 },
    });
    expect(apiErrorMessage(transport('timeout'))).toMatchObject({
      messageKey: 'error.api.timeoutPlain',
      args: undefined,
    });
  });

  it.each([
    ['network', 'error.api.network'],
    ['parse', 'error.api.parse'],
    ['contract', 'error.api.contract'],
    ['aborted', 'error.api.aborted'],
  ] as const)('maps the transport kind %s to %s', (kind, key) => {
    expect(apiErrorMessage(transport(kind))).toMatchObject({ messageKey: key, args: undefined });
  });

  it('maps 403 to the address hint, whatever the envelope says', () => {
    expect(apiErrorMessage(http(403, 'host_not_allowed')).messageKey).toBe('error.api.forbidden');
  });

  it('maps 404 with and without an envelope message', () => {
    expect(apiErrorMessage(http(404, 'session_not_found', 'no such thing'))).toMatchObject({
      messageKey: 'error.api.notFoundDetail',
      args: { detail: 'no such thing' },
    });
    expect(apiErrorMessage(http(404, null, ''))).toMatchObject({ messageKey: 'error.api.notFound', args: undefined });
  });

  it('maps a server failure with the status and the envelope message when there is one', () => {
    expect(apiErrorMessage(http(500, 'internal_error', 'kaput'))).toMatchObject({
      messageKey: 'error.api.serverDetail',
      args: { status: 500, detail: 'kaput' },
    });
    expect(apiErrorMessage(http(503, 'db_busy', ''))).toMatchObject({
      messageKey: 'error.api.server',
      args: { status: 503 },
    });
  });

  it('maps any other status with the status and the envelope message when there is one', () => {
    expect(apiErrorMessage(http(400, 'validation_failed', 'bad filter'))).toMatchObject({
      messageKey: 'error.api.failedDetail',
      args: { status: 400, detail: 'bad filter' },
    });
    expect(apiErrorMessage(http(409, null, ''))).toMatchObject({
      messageKey: 'error.api.failed',
      args: { status: 409 },
    });
  });

  it('never uses the English diagnostic of the error object', () => {
    const message = apiErrorMessage(http(500, 'internal_error'));
    expect(JSON.stringify([message.messageKey, message.args])).not.toContain('diagnostic');
    expect(message.text(tEn)).not.toContain('diagnostic');
  });
});

describe('describeApiError', () => {
  it('renders an ApiError in the language of t', () => {
    const error = http(500, 'internal_error', 'kaput');
    expect(describeApiError(error, tEn)).toBe(msg('error.api.serverDetail', { status: 500, detail: 'kaput' }));
    expect(describeApiError(error, tVi)).toBe(msg('error.api.serverDetail', { status: 500, detail: 'kaput' }, 'vi'));
    expect(describeApiError(error, tVi)).not.toBe(describeApiError(error, tEn));
  });

  it('drops the full stop at the end of the envelope message, which the sentence around it supplies', () => {
    expect(describeApiError(http(500, 'internal_error', 'The monitor could not answer.'), tEn)).toBe(
      msg('error.api.serverDetail', { status: 500, detail: 'The monitor could not answer' }),
    );
  });

  it('keeps the message of any other error, and has nothing for a missing or empty one', () => {
    expect(describeApiError(new Error('connection refused'), tEn)).toBe('connection refused');
    expect(describeApiError(new Error(''), tEn)).toBeUndefined();
    expect(describeApiError(undefined, tEn)).toBeUndefined();
  });
});

describe('error-code table of 04 5.1 (handlingFor)', () => {
  it('cursor_invalid restarts the infinite list and is not retried', () => {
    expect(handlingFor(http(400, 'cursor_invalid'))).toMatchObject({
      action: 'restart-list',
      retry: 'no',
      messageKey: 'error.handling.listChanged',
      args: undefined,
      healthNote: null,
    });
  });

  it.each([
    'validation_failed',
    'param_repeated',
    'range_invalid',
    'range_too_large',
    'filter_requires_scope',
    'query_too_short',
  ] as const)('%s is a rejected filter that quotes the envelope message, not retried', (code) => {
    expect(handlingFor(http(400, code, 'q is too short'))).toMatchObject({
      action: 'rejected-filter',
      retry: 'no',
      messageKey: 'error.handling.rejectedFilterDetail',
      args: { detail: 'q is too short' },
    });
  });

  it('a rejected filter without an envelope message has no detail to quote', () => {
    expect(handlingFor(http(400, 'validation_failed', ''))).toMatchObject({
      messageKey: 'error.handling.rejectedFilter',
      args: undefined,
    });
  });

  it.each(['host_not_allowed', 'origin_not_allowed', 'cross_site_request'] as const)(
    '%s is a full-page refusal that names `$MCS status`, not retried',
    (code) => {
      const handling = handlingFor(http(403, code));
      expect(handling).toMatchObject({
        action: 'refused-address',
        retry: 'no',
        messageKey: 'error.handling.refusedAddress',
      });
      expect(msg('error.handling.refusedAddress')).toContain('$MCS status --task <slug>');
    },
  );

  it.each([
    'session_not_found',
    'agent_not_found',
    'event_not_found',
    'work_item_not_found',
    'route_not_found',
  ] as const)('%s is a not-found state built from the failure, not retried', (code) => {
    expect(handlingFor(http(404, code, 'gone'))).toMatchObject({
      action: 'not-found',
      retry: 'no',
      messageKey: 'error.api.notFoundDetail',
      args: { detail: 'gone' },
    });
  });

  it('panel_disabled removes the panel and is not retried', () => {
    expect(handlingFor(http(404, 'panel_disabled'))).toMatchObject({ action: 'panel-removed', retry: 'no' });
  });

  it('transcript_gone (410) is the gone state', () => {
    expect(handlingFor(http(410, 'transcript_gone'))).toMatchObject({
      action: 'transcript-gone',
      retry: 'no',
      messageKey: 'error.handling.transcriptGone',
    });
  });

  it.each(['search_busy', 'export_busy'] as const)('%s (429) is retried once, then shows busy text', (code) => {
    expect(handlingFor(http(429, code))).toMatchObject({
      action: 'busy',
      retry: 'once',
      messageKey: 'error.handling.busy',
    });
  });

  it('internal_error carries the request id and is retried with backoff', () => {
    expect(handlingFor(http(500, 'internal_error'))).toMatchObject({
      action: 'internal',
      retry: 'backoff',
      messageKey: 'error.handling.internalRequest',
      args: { id: 'r-0123456789ab' },
    });
  });

  it('internal_error without a request id says so without one', () => {
    expect(handlingFor(http(500, 'internal_error', 'x', null))).toMatchObject({
      messageKey: 'error.handling.internal',
      args: undefined,
    });
  });

  it.each(['db_busy', 'shutting_down', 'stream_limit'] as const)('%s (503) is retried with backoff', (code) => {
    expect(handlingFor(http(503, code))).toMatchObject({
      action: 'unavailable',
      retry: 'backoff',
      messageKey: 'error.api.serverDetail',
      healthNote: null,
    });
  });

  it('disk_full (503) is retried and adds the disk note for the health details', () => {
    expect(handlingFor(http(503, 'disk_full'))).toMatchObject({
      action: 'unavailable',
      retry: 'backoff',
      healthNote: { messageKey: 'error.handling.diskFull', args: undefined },
    });
  });

  it('any other code is grouped by status and the code goes to the health details', () => {
    expect(handlingFor(http(409, 'instance_mismatch'))).toMatchObject({
      action: 'other',
      retry: 'no',
      healthNote: { messageKey: 'error.handling.unknownCode', args: { code: 'instance_mismatch' } },
    });
    expect(handlingFor(http(502, null))).toMatchObject({ action: 'other', retry: 'backoff', healthNote: null });
  });

  it('transport kinds: network, timeout and parse retry with backoff; contract and aborted do not', () => {
    for (const [kind, retry] of [
      ['network', 'backoff'],
      ['timeout', 'backoff'],
      ['parse', 'backoff'],
      ['contract', 'no'],
      ['aborted', 'no'],
    ] as const) {
      expect(handlingFor(transport(kind)).retry, kind).toBe(retry);
    }
  });

  it('every catalogue code has a handling whose key exists in both languages', () => {
    for (const code of ERROR_CODES) {
      const handling = handlingFor(http(ERROR_HTTP_STATUS[code], code));
      expect(Object.hasOwn(enMessages, handling.messageKey), code).toBe(true);
      expect(Object.hasOwn(viMessages, handling.messageKey), code).toBe(true);
    }
  });
});

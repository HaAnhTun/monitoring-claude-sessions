import { PANEL_KEYS, type PanelKey } from '@mcs/shared';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeApi, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { makeInstance, makePanelResponse } from '../../test/fixtures/index.ts';
import { renderHookWithProviders } from '../../test/render.tsx';
import { qk } from '../query-keys.ts';
import { usePanel } from './usePanel.ts';

const INSTANCE = makeInstance();
const IID = INSTANCE.instanceId;

function fakeApi(handlers: FakeHandlers = {}): FakeApi {
  return createFakeApi({ instance: () => INSTANCE, ...handlers });
}

describe('usePanel (key and abort)', () => {
  it('asks for the path of its key, caches under the key of the instance and the panel, and keeps panels apart', async () => {
    const api = fakeApi({ panel: (_query, request) => makePanelResponse(request.params['key'] as PanelKey) });
    const { result, queryClient } = renderHookWithProviders(
      () => ({ git: usePanel('git', { expanded: true }), logs: usePanel('logs', { expanded: true }) }),
      { api },
    );
    await waitFor(() => {
      expect(result.current.git.isSuccess && result.current.logs.isSuccess).toBe(true);
    });
    expect(
      api
        .callsTo('panel')
        .map((call) => call.params['key'])
        .sort(),
    ).toEqual(['git', 'logs']);
    expect(
      api
        .callsTo('panel')
        .map((call) => new URL(call.url, 'http://fake.invalid').pathname.split('/').pop())
        .sort(),
    ).toEqual(['git', 'logs']);
    expect(result.current.git.data?.key).toBe('git');
    expect(result.current.logs.data?.key).toBe('logs');
    for (const key of PANEL_KEYS) {
      const cached = queryClient.getQueryData(qk.panel(IID, key));
      if (key === 'git' || key === 'logs') expect(cached).toBeDefined();
      else expect(cached).toBeUndefined();
    }
  });

  it('starts fetching when the panel is expanded and stops asking when it is collapsed again', async () => {
    const api = fakeApi({ panel: () => makePanelResponse('machine') });
    const { result, rerender } = renderHookWithProviders(({ expanded }) => usePanel('machine', { expanded }), {
      api,
      initialProps: { expanded: false },
    });
    await Promise.resolve();
    expect(api.callsTo('panel')).toHaveLength(0);
    rerender({ expanded: true });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(api.callsTo('panel')).toHaveLength(1);
    rerender({ expanded: false });
    expect(result.current.data?.key).toBe('machine');
  });

  it('aborts the request in flight when the panel goes away', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const api = fakeApi({
      panel: (_query, request) => {
        seen.signal = request.signal;
        return new Promise(() => undefined);
      },
    });
    const { unmount } = renderHookWithProviders(() => usePanel('ledger', { expanded: true }), { api });
    await waitFor(() => {
      expect(seen.signal).not.toBeNull();
    });
    expect(seen.signal?.aborted).toBe(false);
    unmount();
    await waitFor(() => {
      expect(seen.signal?.aborted).toBe(true);
    });
  });
});

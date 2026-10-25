import { routes, type HealthReport, type Overview } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeApi, errorResponse, type FakeHandler } from '../../test/fake-api.ts';
import { iso, makeHealth, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { IngestionSummary } from './IngestionSummary.tsx';

const INSTANCE = makeInstance();
const NO_ALERTS: Overview['alerts'] = { open: 0, critical: 0, items: [] };

function health(over: {
  status?: HealthReport['status'];
  hooks?: Partial<HealthReport['ingestion']['hooks']>;
  transcripts?: Partial<HealthReport['ingestion']['transcripts']>;
}): HealthReport {
  const base = makeHealth(over.status ?? 'ok');
  return {
    ...base,
    ingestion: {
      ...base.ingestion,
      hooks: { ...base.ingestion.hooks, ...over.hooks },
      transcripts: { ...base.ingestion.transcripts, ...over.transcripts },
    },
  };
}

/** The page counts as in sync once `instance` and `health` have answered through the API client. */
async function setup(
  report: FakeHandler = () => health({}),
  alerts: Overview['alerts'] | null = NO_ALERTS,
  locale: 'en' | 'vi' = 'en',
) {
  const api = createFakeApi({ instance: () => INSTANCE, health: report });
  const rendered = renderWithProviders(<IngestionSummary alerts={alerts ?? undefined} />, {
    api,
    instance: INSTANCE,
    locale,
  });
  await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
  return rendered;
}

function card(locale: 'en' | 'vi' = 'en'): HTMLElement {
  return screen.getByRole('region', { name: msg('overview.ingestion.title', undefined, locale) });
}

function fact(label: string): HTMLElement {
  const dt = screen.getByText(label, { selector: 'dt' });
  const row = dt.parentElement;
  if (row === null) throw new Error('no fact row');
  return row;
}

describe('IngestionSummary', () => {
  it('shows a placeholder until the health report arrives', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await setup(async () => {
      await gate;
      return health({});
    });
    expect(screen.getByText(msg('overview.ingestion.loading'))).toBeInTheDocument();
    release();
    await screen.findByText(msg('live.ingest.ok'));
  });

  it('says Ingestion OK with a dot and the word, and the facts of the report', async () => {
    await setup(() =>
      health({
        hooks: { enabled: true, lastReceivedAt: iso(-90) },
        transcripts: { lastImportedAt: iso(-30), importLagMs: 4000 },
      }),
    );
    await waitFor(() => {
      expect(card()).toHaveTextContent(msg('live.ingest.ok'));
    });
    expect(card().querySelector('.live-dot[data-tone="ok"]')).not.toBeNull();
    expect(within(fact(msg('overview.ingestion.lastHook'))).getByRole('time')).toBeInTheDocument();
    expect(within(fact(msg('overview.ingestion.lastTranscript'))).getByRole('time')).toBeInTheDocument();
    expect(fact(msg('overview.ingestion.lag'))).toHaveTextContent('4s');
  });

  it('says that hooks are off instead of a time that will never come', async () => {
    await setup(() => health({ hooks: { enabled: false } }));
    await waitFor(() => {
      expect(fact(msg('overview.ingestion.lastHook'))).toHaveTextContent(msg('overview.ingestion.hooksOff'));
    });
  });

  it('shows "not available" for a lag the monitor cannot give, never a zero', async () => {
    await setup(() => health({ transcripts: { importLagMs: null } }));
    await waitFor(() => {
      expect(fact(msg('overview.ingestion.lag'))).toHaveTextContent(msg('common.notAvailable'));
    });
    expect(fact(msg('overview.ingestion.lag')).textContent).not.toMatch(/0/);
  });

  it('names a degraded status in the language of the page', async () => {
    await setup(() => health({ status: 'degraded' }));
    await waitFor(() => {
      expect(card()).toHaveTextContent(msg('live.ingest.degraded'));
    });
    expect(card().querySelector('.live-dot[data-tone="stale"]')).not.toBeNull();
  });

  it('counts the open alerts and the critical ones, or says none', async () => {
    const view = await setup(undefined, { open: 3, critical: 1, items: [] });
    await waitFor(() => {
      expect(fact(msg('overview.ingestion.alerts'))).toHaveTextContent(
        `3 (${msg('overview.ingestion.critical', { count: '1' })})`,
      );
    });
    view.unmount();
    await setup(undefined, NO_ALERTS);
    await waitFor(() => {
      expect(fact(msg('overview.ingestion.alerts'))).toHaveTextContent(msg('overview.ingestion.alertsNone'));
    });
  });

  it('shows "not available" for the alerts while the overview is not loaded', async () => {
    await setup(undefined, null);
    await waitFor(() => {
      expect(fact(msg('overview.ingestion.alerts'))).toHaveTextContent(msg('common.notAvailable'));
    });
  });

  it('links to the long form in Settings', async () => {
    await setup();
    expect(screen.getByRole('link', { name: msg('overview.ingestion.details') })).toHaveAttribute(
      'href',
      '/settings?section=health',
    );
  });

  it('says so, with a retry, when the report cannot be loaded', async () => {
    await setup(() => errorResponse('internal_error'));
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
  });

  it('speaks Vietnamese', async () => {
    await setup(undefined, NO_ALERTS, 'vi');
    await waitFor(() => {
      expect(card('vi')).toHaveTextContent(msg('live.ingest.ok', undefined, 'vi'));
    });
    expect(screen.getByText(msg('overview.ingestion.lastTranscript', undefined, 'vi'))).toBeInTheDocument();
  });
});

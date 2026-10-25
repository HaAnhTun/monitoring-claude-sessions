import { routes, type AlertItem, type ErrorItem, type HealthReport } from '@mcs/shared';
import { createQueryClient } from '../../data/query-client.ts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { createFakeApi, errorResponse, type FakeHandler } from '../../test/fake-api.ts';
import { FIXTURE_INSTANCE_ID, iso, makeHealth, makeInstance, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { HealthPanel } from './HealthPanel.tsx';

const INSTANCE = makeInstance();

function makeAlert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 1,
    seq: 5,
    ruleId: 'import_lag',
    rule: 'import_lag',
    severity: 'warning',
    status: 'open',
    title: 'FIXTURE alert: the import is behind',
    scope: { kind: 'instance', key: 'instance' },
    sessionId: null,
    since: iso(-600),
    lastFiredAt: iso(-60),
    fireCount: 3,
    resolvedAt: null,
    resolvedReason: null,
    detail: {},
    ...overrides,
  };
}

function makeError(n: number): ErrorItem {
  return {
    at: iso(-n),
    source: 'server',
    code: 'INTERNAL',
    where: n % 2 === 0 ? `route-${String(n)}` : null,
    message: `FIXTURE server error ${String(n)}`,
    sessionId: null,
  };
}

function withRuntime(overrides: Partial<HealthReport['runtime']>): Partial<HealthReport> {
  return { runtime: { ...makeHealth().runtime, ...overrides } };
}

/** The page counts as in sync once `instance` and `health` have answered through the API client. */
async function renderPanel(health: FakeHandler = () => makeHealth('ok')) {
  const api = createFakeApi({ instance: () => INSTANCE, health });
  const rendered = renderWithProviders(<HealthPanel />, { api, instance: INSTANCE });
  await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
  return rendered;
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('HealthPanel', () => {
  it('draws the connection, ingestion, database and server cards, the alerts and the errors', async () => {
    await renderPanel();
    await screen.findByRole('region', { name: msg('settings.health.database') });
    for (const name of [
      msg('live.section.connection'),
      msg('live.section.ingestion'),
      msg('settings.health.database'),
      msg('live.section.server'),
      msg('settings.health.alerts'),
      msg('settings.health.errors'),
    ]) {
      expect(card(name)).toBeInTheDocument();
    }
    const server = card(msg('live.section.server'));
    expect(within(server).getByText('3.0.0')).toBeInTheDocument();
    expect(within(server).getByText('fixture-stamp')).toBeInTheDocument();
    expect(within(server).getByText('0a1b2c3d')).toBeInTheDocument();
    expect(card(msg('settings.health.alerts'))).toHaveTextContent(msg('settings.health.alerts.none'));
    expect(card(msg('settings.health.errors'))).toHaveTextContent(msg('live.errors.none'));
  });

  it('says Ingestion OK only while the client is in sync', async () => {
    await renderPanel();
    await waitFor(() => {
      expect(card(msg('live.section.ingestion'))).toHaveTextContent(msg('live.ingest.ok'));
    });
    expect(card(msg('live.section.ingestion')).textContent).not.toContain(
      msg('settings.health.cached', { time: 'TIME_X' }).split('TIME_X')[0] ?? 'x',
    );
  });

  it('never says OK while the client is not in sync: the ingestion is unknown, with the last known status and a warning', async () => {
    const queryClient = createQueryClient({ retry: false });
    queryClient.setQueryData(qk.health(FIXTURE_INSTANCE_ID), makeHealth('ok'));
    const api = createFakeApi({ instance: () => INSTANCE, health: () => errorResponse('internal_error') });
    const rendered = renderWithProviders(<HealthPanel />, { api, instance: INSTANCE, queryClient });
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);

    const ingestion = card(msg('live.section.ingestion'));
    await waitFor(() => {
      expect(ingestion).toHaveTextContent(msg('live.ingest.unknown'));
    });
    expect(ingestion).not.toHaveTextContent(msg('live.ingest.ok'));
    expect(ingestion).toHaveTextContent(msg('live.ingest.lastKnownNoAge', { status: msg('live.ingest.status.ok') }));
    expect(ingestion.querySelector('[data-ingestion]')?.getAttribute('data-ingestion')).toBe('unknown');
    // The report that is still drawn is marked as not current.
    const [before = '', after = ''] = msg('settings.health.cached', { time: 'TIME_X' }).split('TIME_X');
    expect(ingestion.textContent).toContain(before);
    expect(ingestion.textContent).toContain(after);
  });

  it('reports a degraded ingestion with the reasons of the server', async () => {
    await renderPanel(() => makeHealth('degraded'));
    const ingestion = await screen.findByRole('region', { name: msg('live.section.ingestion') });
    await waitFor(() => {
      expect(ingestion).toHaveTextContent(msg('live.ingest.degraded'));
    });
    expect(within(ingestion).getByText('FIXTURE reason')).toBeInTheDocument();
  });

  it('writes a known reason code as a sentence and keeps any other text as the server sent it', async () => {
    const base = makeHealth('degraded');
    await renderPanel(() =>
      makeHealth('degraded', {
        ingestion: { ...base.ingestion, reasons: ['IMPORT_LAG', 'FIXTURE_UNKNOWN_CODE', 'toString'] },
      }),
    );
    const ingestion = await screen.findByRole('region', { name: msg('live.section.ingestion') });
    await waitFor(() => {
      expect(ingestion).toHaveTextContent(msg('settings.health.reason.IMPORT_LAG'));
    });
    expect(ingestion).not.toHaveTextContent('IMPORT_LAG');
    expect(within(ingestion).getByText('FIXTURE_UNKNOWN_CODE')).toBeInTheDocument();
    expect(within(ingestion).getByText('toString')).toBeInTheDocument();
  });

  it('shows the hooks and the transcripts figures, and a note when hooks are off', async () => {
    await renderPanel();
    const ingestion = await screen.findByRole('region', { name: msg('live.section.ingestion') });
    await waitFor(() => {
      expect(ingestion).toHaveTextContent(msg('settings.health.transcripts'));
    });
    expect(ingestion).toHaveTextContent(msg('settings.health.hooks.off'));
    expect(within(ingestion).getByText(msg('settings.health.transcripts.files'))).toBeInTheDocument();
    expect(within(ingestion).queryByText(msg('settings.health.hooks.backlog'))).not.toBeInTheDocument();
  });

  it('shows the hook details when hooks are on', async () => {
    const base = makeHealth('ok');
    await renderPanel(() =>
      makeHealth('ok', {
        ingestion: {
          ...base.ingestion,
          hooks: {
            enabled: true,
            installed: true,
            lastReceivedAt: iso(-30),
            lastEventAt: iso(-31),
            spoolPendingBytes: 2048,
            spoolLagMs: 1500,
            errorsLastHour: 2,
            lastError: {
              at: iso(-90),
              source: 'hooks',
              code: 'HOOK_BAD',
              where: null,
              message: 'FIXTURE hook failure',
              sessionId: null,
            },
          },
        },
      }),
    );
    const ingestion = await screen.findByRole('region', { name: msg('live.section.ingestion') });
    await waitFor(() => {
      expect(within(ingestion).getByText(msg('settings.health.hooks.backlog'))).toBeInTheDocument();
    });
    expect(within(ingestion).getByText('2 KB')).toBeInTheDocument();
    expect(within(ingestion).getByText('hooks/HOOK_BAD')).toBeInTheDocument();
    expect(within(ingestion).getByText('FIXTURE hook failure')).toBeInTheDocument();
    expect(within(ingestion).queryByText(msg('settings.health.hooks.off'))).not.toBeInTheDocument();
  });

  it('lists the open alerts with severity, rule, times, fire count and a link to the session', async () => {
    const sid = sessionId(7);
    await renderPanel(() =>
      makeHealth('ok', {
        alerts: [
          makeAlert({ id: 1, severity: 'critical', title: 'FIXTURE critical alert', sessionId: sid, fireCount: 1 }),
          makeAlert({ id: 2, severity: 'warning', title: 'FIXTURE warning alert', rule: 'hook_gap' }),
        ],
      }),
    );
    const alerts = await screen.findByRole('region', { name: msg('settings.health.alerts') });
    await waitFor(() => {
      expect(within(alerts).getAllByRole('listitem')).toHaveLength(2);
    });
    const [critical, warning] = within(alerts).getAllByRole('listitem');
    if (critical === undefined || warning === undefined) throw new Error('missing alert rows');
    expect(critical).toHaveTextContent(msg('settings.health.alerts.critical'));
    expect(critical).toHaveTextContent('FIXTURE critical alert');
    expect(critical).toHaveTextContent(msg('settings.health.alerts.fired', { count: 1 }));
    expect(within(critical).getByRole('link', { name: msg('settings.health.alerts.session') })).toHaveAttribute(
      'href',
      `/sessions/${sid}`,
    );
    expect(warning).toHaveTextContent(msg('settings.health.alerts.warning'));
    expect(warning).toHaveTextContent('hook_gap');
    expect(warning).toHaveTextContent(msg('settings.health.alerts.fired', { count: 3 }));
    expect(within(warning).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows every server error the report holds, newest first, and no more than the cap of the server', async () => {
    const errors = Array.from({ length: 20 }, (_unused, index) => makeError(index));
    await renderPanel(() => makeHealth('ok', { errors }));
    const card20 = await screen.findByRole('region', { name: msg('settings.health.errors') });
    await waitFor(() => {
      expect(within(card20).getAllByRole('listitem')).toHaveLength(20);
    });
    const items = within(card20).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('FIXTURE server error 0');
    expect(items[19]).toHaveTextContent('FIXTURE server error 19');
    expect(card20).toHaveTextContent(msg('settings.health.errors.note', { max: 20 }));
    expect(items[0]).toHaveTextContent('server/INTERNAL');
    expect(items[0]).toHaveTextContent('route-0');
  });

  it('shows the warnings of the server and the command that restarts it', async () => {
    await renderPanel(() =>
      makeHealth('ok', withRuntime({ outdated: true, previousRunUnclean: true, ownershipConflict: true })),
    );
    const server = await screen.findByRole('region', { name: msg('live.section.server') });
    await waitFor(() => {
      expect(server).toHaveTextContent(msg('live.server.restartNeeded'));
    });
    expect(server).toHaveTextContent(msg('live.server.unclean'));
    expect(server).toHaveTextContent(msg('live.server.conflict'));
    expect(server).not.toHaveTextContent(msg('settings.health.server.ok'));
    expect(within(server).getByText(INSTANCE.commands.restart)).toBeInTheDocument();
  });

  it('shows the database as failed with its last error', async () => {
    const base = makeHealth('ok');
    await renderPanel(() => makeHealth('ok', { db: { ...base.db, ok: false, lastError: 'FIXTURE disk problem' } }));
    const database = await screen.findByRole('region', { name: msg('settings.health.database') });
    await waitFor(() => {
      expect(database).toHaveTextContent(msg('settings.health.database.failed'));
    });
    expect(database).toHaveTextContent('FIXTURE disk problem');
  });

  it('keeps the connection card and offers a retry when the report cannot be loaded', async () => {
    await renderPanel(() => errorResponse('internal_error'));
    expect(card(msg('live.section.connection'))).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: msg('settings.health.database') })).not.toBeInTheDocument();
  });

  it('answers in Vietnamese', async () => {
    const api = createFakeApi({ instance: () => INSTANCE, health: () => makeHealth('ok') });
    const rendered = renderWithProviders(<HealthPanel />, { api, instance: INSTANCE, locale: 'vi' });
    await rendered.apiClient.get('instance', routes.instance.path, routes.instance.response);
    expect(
      await screen.findByRole('region', { name: msg('settings.health.database', undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});

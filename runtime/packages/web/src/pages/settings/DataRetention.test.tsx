import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFormatters } from '../../i18n/format.ts';
import { createFakeApi, errorResponse, type FakeHandler } from '../../test/fake-api.ts';
import { makeHealth, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { DataRetention } from './DataRetention.tsx';

// Awkward on purpose: spaces, quotes, a dollar sign and a backslash must reach the clipboard exactly as the server wrote them.
const INSTANCE = makeInstance({
  retention: { summary: 'FIXTURE: sessions are kept for 90 days; logs for 30 days.' },
  commands: {
    status: 'status',
    restart: 'restart',
    inspect: 'inspect',
    export: 'node "/work dir/mcs.mjs" export --task fixture --out "/work dir/logs/export.ndjson" --repo "/work dir"',
    backup: 'node /work/mcs.mjs backup --task fixture --repo /work',
    cleanupDryRun: 'node /work/mcs.mjs cleanup --task fixture --scope logs --repo "C:/work $HOME\\x"',
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderData(health: FakeHandler = () => makeHealth('ok')) {
  const api = createFakeApi({ instance: () => INSTANCE, health });
  return renderWithProviders(<DataRetention />, { api, instance: INSTANCE });
}

describe('DataRetention', () => {
  it('shows the size of the database and the retention text of the instance', async () => {
    renderData();
    const storage = await screen.findByRole('region', { name: msg('settings.data.storage') });
    await waitFor(() => {
      expect(storage).toHaveTextContent(createFormatters('en').bytes(makeHealth('ok').db.sizeBytes));
    });
    expect(storage).toHaveTextContent(msg('settings.data.size'));
    expect(screen.getByRole('region', { name: msg('settings.data.retention') })).toHaveTextContent(
      INSTANCE.retention.summary,
    );
  });

  it('says the size is not available while the health report is missing', async () => {
    renderData(() => errorResponse('internal_error'));
    const storage = await screen.findByRole('region', { name: msg('settings.data.storage') });
    expect(within(storage).getAllByText(msg('common.notAvailable'))).toHaveLength(3);
  });

  it.each([
    ['settings.data.copyExport', 'export'],
    ['settings.data.copyBackup', 'backup'],
    ['settings.data.copyCleanup', 'cleanupDryRun'],
  ] as const)('copies the %s command exactly as the server wrote it', async (label, key) => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderData();
    expect(await screen.findByText(INSTANCE.commands[key])).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg(label) }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(INSTANCE.commands[key]);
    });
  });

  it('describes each command and offers no other action', async () => {
    renderData();
    const commands = await screen.findByRole('region', { name: msg('settings.data.commands') });
    expect(within(commands).getAllByRole('listitem')).toHaveLength(3);
    for (const key of ['settings.data.exportHint', 'settings.data.backupHint', 'settings.data.cleanupHint'] as const) {
      expect(commands).toHaveTextContent(msg(key));
    }
    expect(within(commands).getAllByRole('button')).toHaveLength(3);
  });
});

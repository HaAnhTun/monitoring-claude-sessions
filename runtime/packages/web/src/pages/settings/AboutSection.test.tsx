import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeApi } from '../../test/fake-api.ts';
import { FIXTURE_INSTANCE_ID, makeHealth, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AboutSection } from './AboutSection.tsx';

const INSTANCE = makeInstance({ dbSchemaVersion: 7, runtimeVersion: '4.0.0', codeStamp: 'stamp-fixture' });

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAbout(outdated: boolean, buildId = 'build-fixture') {
  const base = makeHealth('ok');
  const api = createFakeApi({
    instance: () => INSTANCE,
    health: () => makeHealth('ok', { runtime: { ...base.runtime, outdated } }),
  });
  return renderWithProviders(<AboutSection buildId={buildId} />, { api, instance: INSTANCE });
}

describe('AboutSection', () => {
  it('shows the versions, the stamp, the instance, the schema, the start time and the interface build', async () => {
    renderAbout(false);
    const running = await screen.findByRole('region', { name: msg('settings.about.running') });
    expect(within(running).getByText('4.0.0')).toBeInTheDocument();
    expect(within(running).getByText('stamp-fixture')).toBeInTheDocument();
    expect(within(running).getByText('build-fixture')).toBeInTheDocument();
    const instance = screen.getByRole('region', { name: msg('settings.about.instance') });
    expect(within(instance).getByText(FIXTURE_INSTANCE_ID)).toBeInTheDocument();
    expect(within(instance).getByText('fixture')).toBeInTheDocument();
    expect(within(instance).getByText('7')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(running).getByText(msg('settings.about.started'))).toBeInTheDocument();
      expect(running.querySelector('time')).not.toBeNull();
    });
  });

  it('says that the running code matches the disk, and offers no restart command', async () => {
    renderAbout(false);
    expect(await screen.findByText(msg('settings.about.current'))).toBeInTheDocument();
    expect(screen.queryByText(msg('settings.about.outdated'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('settings.about.copyRestart') })).not.toBeInTheDocument();
  });

  it('warns that the running code differs from the disk and copies the restart command of the instance', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderAbout(true);
    expect(await screen.findByText(msg('settings.about.outdated'))).toBeInTheDocument();
    expect(screen.getByText(INSTANCE.commands.restart)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('settings.about.copyRestart') }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(INSTANCE.commands.restart);
    });
  });

  it('does not claim anything about the code while the health report is missing', async () => {
    const api = createFakeApi({ instance: () => INSTANCE });
    renderWithProviders(<AboutSection buildId="build-fixture" />, { api, instance: INSTANCE });
    await screen.findByRole('region', { name: msg('settings.about.running') });
    expect(screen.queryByText(msg('settings.about.current'))).not.toBeInTheDocument();
    expect(screen.queryByText(msg('settings.about.outdated'))).not.toBeInTheDocument();
  });

  it('shows a dash when the interface build has no id', async () => {
    renderAbout(false, '');
    const running = await screen.findByRole('region', { name: msg('settings.about.running') });
    const build = within(running).getByText(msg('settings.about.build')).closest('.settings-fact');
    expect(build).toHaveTextContent('-');
  });
});

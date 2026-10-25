import { CONFIG_SOURCES } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeApi, errorResponse, type FakeHandler } from '../../test/fake-api.ts';
import { makeConfigInspection, makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ConfigInspector, valueText, VALUE_CLAMP_CHARS } from './ConfigInspector.tsx';

const INSTANCE = makeInstance();

function renderInspector(config: FakeHandler = () => makeConfigInspection(), locale: 'en' | 'vi' = 'en') {
  const api = createFakeApi({ instance: () => INSTANCE, config });
  return renderWithProviders(<ConfigInspector />, { api, instance: INSTANCE, locale });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConfigInspector', () => {
  it('draws a row per key with its value as JSON text and the tag of its source', async () => {
    renderInspector(() =>
      makeConfigInspection({
        entries: CONFIG_SOURCES.map((source, index) => ({ key: `fixture.key_${source}`, value: index, source })),
      }),
    );
    const table = await screen.findByRole('table', { name: msg('settings.config.caption') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(CONFIG_SOURCES.length);
    for (const [index, source] of CONFIG_SOURCES.entries()) {
      const row = rows[index];
      if (row === undefined) throw new Error('missing row');
      expect(within(row).getByText(`fixture.key_${source}`)).toBeInTheDocument();
      expect(within(row).getByText(String(index))).toBeInTheDocument();
      const tag = row.querySelector(`[data-source="${source}"]`);
      expect(tag).toHaveTextContent(msg(`settings.config.source.${source}`));
    }
  });

  it('draws strings with quotes, structures as JSON and null as null', async () => {
    renderInspector(() =>
      makeConfigInspection({
        entries: [
          { key: 'fixture.text', value: 'plain', source: 'config' },
          { key: 'fixture.list', value: ['a', 1, true], source: 'runtime' },
          { key: 'fixture.none', value: null, source: 'builtin' },
          { key: 'fixture.object', value: { nested: { deep: 2 } }, source: 'skill' },
        ],
      }),
    );
    await screen.findByRole('table');
    expect(screen.getByText('"plain"')).toBeInTheDocument();
    expect(screen.getByText('["a",1,true]')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.getByText('{"nested":{"deep":2}}')).toBeInTheDocument();
  });

  it('does not treat a key that looks secret differently: the server already redacted it and the page shows what arrives', async () => {
    renderInspector(() =>
      makeConfigInspection({
        entries: [
          { key: 'fixture.api_token', value: '[redacted]', source: 'env' },
          { key: 'fixture.password_hint', value: 'FIXTURE visible value', source: 'config' },
        ],
      }),
    );
    await screen.findByRole('table');
    expect(screen.getByText('"[redacted]"')).toBeInTheDocument();
    expect(screen.getByText('"FIXTURE visible value"')).toBeInTheDocument();
  });

  it('clamps a long value and shows all of it behind Show more', async () => {
    const long = 'x'.repeat(VALUE_CLAMP_CHARS * 3);
    renderInspector(() => makeConfigInspection({ entries: [{ key: 'fixture.long', value: long, source: 'config' }] }));
    await screen.findByRole('table');
    const shownBefore = document.querySelector('.settings-value')?.textContent ?? '';
    expect(shownBefore.length).toBeLessThanOrEqual(VALUE_CLAMP_CHARS);
    await userEvent.setup().click(screen.getByRole('button', { name: msg('common.showMore') }));
    expect(document.querySelector('.settings-value')?.textContent).toBe(valueText(long));
  });

  it('lists the files with their state, the effective port and the engine', async () => {
    renderInspector(() =>
      makeConfigInspection({
        files: [
          { name: 'defaults.json', path: 'FIXTURE/defaults.json', schemaVersion: 1, present: true, ok: true },
          { name: 'config.json', path: 'FIXTURE/config.json', schemaVersion: null, present: true, ok: false },
          { name: 'runtime.json', path: 'FIXTURE/runtime.json', schemaVersion: null, present: false, ok: true },
        ],
        effectivePort: 18901,
        engine: null,
      }),
    );
    const files = await screen.findByRole('region', { name: msg('settings.config.files') });
    const items = within(files).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(msg('settings.config.file.ok'));
    expect(items[0]).toHaveTextContent(msg('settings.config.file.schema', { version: 1 }));
    expect(items[1]).toHaveTextContent(msg('settings.config.file.invalid'));
    expect(items[2]).toHaveTextContent(msg('settings.config.file.missing'));
    expect(items[2]).toHaveTextContent('FIXTURE/runtime.json');
    expect(files).toHaveTextContent('18901');
    expect(files).toHaveTextContent(msg('settings.config.engine.none'));
  });

  it('shows the inspect command of the instance and copies it exactly', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderInspector();
    const button = await screen.findByRole('button', { name: msg('settings.config.copyInspect') });
    expect(screen.getByText(INSTANCE.commands.inspect)).toBeInTheDocument();
    await user.click(button);
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(INSTANCE.commands.inspect);
    });
  });

  it('says so when no value was reported', async () => {
    renderInspector(() => makeConfigInspection({ entries: [] }));
    expect(await screen.findByText(msg('settings.config.empty'))).toBeInTheDocument();
  });

  it('shows an error with a retry when the configuration cannot be read', async () => {
    renderInspector(() => errorResponse('internal_error'));
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('uses the Vietnamese words for the columns and the source tags', async () => {
    renderInspector(
      () => makeConfigInspection({ entries: [{ key: 'fixture.port', value: 1, source: 'builtin' }] }),
      'vi',
    );
    const table = await screen.findByRole('table', { name: msg('settings.config.caption', undefined, 'vi') });
    await waitFor(() => {
      expect(
        within(table).getByRole('columnheader', { name: msg('settings.config.source', undefined, 'vi') }),
      ).toBeInTheDocument();
    });
    expect(within(table).getByText(msg('settings.config.source.builtin', undefined, 'vi'))).toBeInTheDocument();
  });
});

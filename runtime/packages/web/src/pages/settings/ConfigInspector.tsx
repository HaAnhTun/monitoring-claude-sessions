// The configuration the monitor runs with (04-ui.md 4.4.7, ADR 0031): one row per key with its value as text and the layer it
// came from, the state of the configuration files, the effective port and the engine. Read only. The server already redacts what
// must not be shown, so no key is treated specially here: what arrives is what is drawn.
import type { ConfigFileStatus, ConfigInspection, ConfigInspectionEntry, ConfigSource } from '@mcs/shared';

import { ClampedText } from '../../components/ClampedText.tsx';
import { DataTable, type Column, type DataCard } from '../../components/DataTable.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useConfigInspection } from '../../data/hooks/useConfigInspection.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { CommandLine, Fact, Facts, SettingsCard, Verdict } from './SettingsParts.tsx';

/** A value longer than this starts collapsed behind "Show more": two lines of the value column at 1024 px keep a row under 80 px. */
export const VALUE_CLAMP_CHARS = 80;

const SOURCE_LABELS = {
  builtin: 'settings.config.source.builtin',
  skill: 'settings.config.source.skill',
  config: 'settings.config.source.config',
  runtime: 'settings.config.source.runtime',
  env: 'settings.config.source.env',
  cli: 'settings.config.source.cli',
} as const satisfies Record<ConfigSource, MessageKey>;

const SOURCE_TIPS = {
  builtin: 'settings.config.sourceTip.builtin',
  skill: 'settings.config.sourceTip.skill',
  config: 'settings.config.sourceTip.config',
  runtime: 'settings.config.sourceTip.runtime',
  env: 'settings.config.sourceTip.env',
  cli: 'settings.config.sourceTip.cli',
} as const satisfies Record<ConfigSource, MessageKey>;

/** The value as the text a person would paste into a config file: JSON, strings quoted. */
export function valueText(value: unknown): string {
  // JSON.stringify answers undefined for a value JSON cannot hold (the API never sends one, but a type says unknown).
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text : 'null';
}

function SourceTag({ source }: { source: ConfigSource }) {
  const t = useT();
  return (
    <span className="settings-source" data-source={source}>
      <TagBadge tone="neutral" tip={t(SOURCE_TIPS[source])}>
        {t(SOURCE_LABELS[source])}
      </TagBadge>
    </span>
  );
}

function Value({ entry }: { entry: ConfigInspectionEntry }) {
  return (
    <ClampedText
      id={`config-${entry.key}`}
      text={valueText(entry.value)}
      clampChars={VALUE_CLAMP_CHARS}
      render={(text) => <code className="settings-value">{text}</code>}
    />
  );
}

function entryCard(entry: ConfigInspectionEntry): DataCard {
  return {
    title: <code className="settings-key">{entry.key}</code>,
    end: <SourceTag source={entry.source} />,
    meta: <Value entry={entry} />,
  };
}

function ValuesTable({ entries }: { entries: readonly ConfigInspectionEntry[] }) {
  const t = useT();
  const columns: Column<ConfigInspectionEntry>[] = [
    {
      id: 'key',
      header: t('settings.config.key'),
      cell: (entry) => <code className="settings-key">{entry.key}</code>,
    },
    { id: 'value', header: t('settings.config.value'), cell: (entry) => <Value entry={entry} /> },
    {
      id: 'source',
      header: t('settings.config.source'),
      cell: (entry) => <SourceTag source={entry.source} />,
      nowrap: true,
    },
  ];
  return (
    <div className="settings-config-table">
      <DataTable
        caption={t('settings.config.caption')}
        columns={columns}
        rows={[...entries]}
        rowKey={(entry) => entry.key}
        card={entryCard}
      />
    </div>
  );
}

function fileTone(file: ConfigFileStatus): 'ok' | 'failed' | 'idle' {
  if (!file.present) return 'idle';
  return file.ok ? 'ok' : 'failed';
}

function FileRow({ file }: { file: ConfigFileStatus }) {
  const t = useT();
  const tone = fileTone(file);
  const word = !file.present
    ? t('settings.config.file.missing')
    : file.ok
      ? t('settings.config.file.ok')
      : t('settings.config.file.invalid');
  return (
    <li className="settings-file" data-present={file.present}>
      <div className="settings-file__head">
        <code className="settings-key">{file.name}</code>
        <Verdict tone={tone}>{word}</Verdict>
        {file.schemaVersion === null ? null : (
          <span className="muted small">{t('settings.config.file.schema', { version: file.schemaVersion })}</span>
        )}
      </div>
      <code className="settings-file__path muted small" title={file.path}>
        {file.path}
      </code>
    </li>
  );
}

function Inspection({ config }: { config: ConfigInspection }) {
  const t = useT();
  const inspect = useInstance().data?.commands.inspect;
  return (
    <div className="settings-config">
      <SettingsCard title={t('settings.config.values')} wide>
        {config.entries.length === 0 ? (
          <p className="muted">{t('settings.config.empty')}</p>
        ) : (
          <ValuesTable entries={config.entries} />
        )}
      </SettingsCard>
      <div className="settings-grid">
        <SettingsCard title={t('settings.config.files')}>
          <ul className="settings-list" data-list="files">
            {config.files.map((file) => (
              <FileRow key={file.name} file={file} />
            ))}
          </ul>
          <Facts>
            <Fact label={t('settings.config.port')} mono>
              {String(config.effectivePort)}
            </Fact>
            <Fact label={t('settings.config.engine')}>
              {config.engine === null ? t('settings.config.engine.none') : <code>{config.engine}</code>}
            </Fact>
          </Facts>
        </SettingsCard>
        {inspect === undefined ? null : (
          <SettingsCard title={t('settings.config.inspect')}>
            <CommandLine command={inspect} copyLabel={t('settings.config.copyInspect')} />
          </SettingsCard>
        )}
      </div>
    </div>
  );
}

export function ConfigInspector() {
  const t = useT();
  const query = useConfigInspection();
  if (query.data !== undefined) return <Inspection config={query.data} />;
  if (query.isError) {
    return (
      <ErrorState
        kind="load"
        subjectKey="error.subject.config"
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return <Skeleton variant="table" rows={8} columns={3} label={t('common.loading')} />;
}

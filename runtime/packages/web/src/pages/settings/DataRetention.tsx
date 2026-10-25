// What the monitor keeps and how long (04-ui.md 4.4.7): the size of the database, the retention text of the instance and the
// commands that export, back up or clean the data. The commands are the strings of `instance.commands`, copied as they are: the
// page never builds a shell string and never runs one (ADR 0031).
import { Skeleton } from '../../components/Skeleton.tsx';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import { CommandLine, Fact, Facts, SettingsCard } from './SettingsParts.tsx';

interface CommandSpec {
  key: 'export' | 'backup' | 'cleanupDryRun';
  title: MessageKey;
  hint: MessageKey;
  copy: MessageKey;
}

const COMMANDS = [
  {
    key: 'export',
    title: 'settings.data.export',
    hint: 'settings.data.exportHint',
    copy: 'settings.data.copyExport',
  },
  {
    key: 'backup',
    title: 'settings.data.backup',
    hint: 'settings.data.backupHint',
    copy: 'settings.data.copyBackup',
  },
  {
    key: 'cleanupDryRun',
    title: 'settings.data.cleanup',
    hint: 'settings.data.cleanupHint',
    copy: 'settings.data.copyCleanup',
  },
] as const satisfies readonly CommandSpec[];

export function DataRetention() {
  const t = useT();
  const format = useFormat();
  const instance = useInstance().data;
  const health = useHealth();
  const db = health.data?.db;
  if (instance === undefined) return <Skeleton variant="list" rows={4} label={t('common.loading')} />;
  return (
    <div className="settings-grid">
      <SettingsCard title={t('settings.data.storage')}>
        <Facts>
          <Fact label={t('settings.data.size')}>
            {db === undefined ? t('common.notAvailable') : format.bytes(db.sizeBytes)}
          </Fact>
          <Fact label={t('settings.data.wal')}>
            {db === undefined ? t('common.notAvailable') : format.bytes(db.walBytes)}
          </Fact>
          <Fact label={t('settings.data.free')}>
            {db?.freeDiskBytes === undefined || db.freeDiskBytes === null
              ? t('common.notAvailable')
              : format.bytes(db.freeDiskBytes)}
          </Fact>
        </Facts>
      </SettingsCard>
      <SettingsCard title={t('settings.data.retention')}>
        <p className="settings-retention">
          <ServerText>{instance.retention.summary}</ServerText>
        </p>
      </SettingsCard>
      <SettingsCard title={t('settings.data.commands')} wide>
        <ul className="settings-list" data-list="commands">
          {COMMANDS.map((spec) => (
            <li key={spec.key} className="settings-command-item">
              <h4 className="settings-card__subtitle">{t(spec.title)}</h4>
              <p className="muted small">{t(spec.hint)}</p>
              <CommandLine command={instance.commands[spec.key]} copyLabel={t(spec.copy)} />
            </li>
          ))}
        </ul>
      </SettingsCard>
    </div>
  );
}

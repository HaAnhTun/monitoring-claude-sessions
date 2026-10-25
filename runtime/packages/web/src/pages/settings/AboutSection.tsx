// Which build is running (04-ui.md 4.4.7): the runtime version and code stamp, whether the running code differs from the files on
// disk (with the command that restarts it), the instance, the schema, when it started and the build of this interface.
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Skeleton } from '../../components/Skeleton.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useHealth } from '../../data/hooks/useHealth.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useFormat, useT } from '../../i18n/context.ts';
import { CommandLine, Dash, Fact, Facts, SettingsCard } from './SettingsParts.tsx';

/** The build id that the web build stamped into the bundle (`MCS_BUILD_ID`), or '' when the build did not set one. */
function bundledBuildId(): string {
  const value: unknown = import.meta.env['VITE_BUILD_ID'];
  return typeof value === 'string' ? value : '';
}

export interface AboutSectionProps {
  /** The build id of this interface; tests pass one, the page reads the one of the bundle. */
  buildId?: string;
}

export function AboutSection({ buildId = bundledBuildId() }: AboutSectionProps) {
  const t = useT();
  const format = useFormat();
  const instance = useInstance().data;
  const runtime = useHealth().data?.runtime;
  if (instance === undefined) return <Skeleton variant="list" rows={4} label={t('common.loading')} />;
  return (
    <div className="settings-grid">
      <SettingsCard title={t('settings.about.running')}>
        {runtime === undefined ? null : runtime.outdated ? (
          <div className="settings-outdated">
            <TagBadge tone="stale" icon="alert">
              {t('settings.about.outdated')}
            </TagBadge>
            <p className="muted small">{t('settings.about.restart')}</p>
            <CommandLine command={instance.commands.restart} copyLabel={t('settings.about.copyRestart')} />
          </div>
        ) : (
          <p className="muted small">{t('settings.about.current')}</p>
        )}
        <Facts>
          <Fact label={t('settings.about.version')} mono>
            {instance.runtimeVersion}
          </Fact>
          <Fact label={t('settings.about.codeStamp')} mono>
            {instance.codeStamp}
          </Fact>
          <Fact label={t('settings.about.build')} mono>
            {buildId === '' ? <Dash /> : buildId}
          </Fact>
          <Fact label={t('settings.about.started')}>
            {runtime === undefined ? <Dash /> : <RelativeTime iso={runtime.startedAt} mode="both" />}
          </Fact>
        </Facts>
      </SettingsCard>
      <SettingsCard title={t('settings.about.instance')}>
        <Facts>
          <Fact label={t('settings.about.title')}>{instance.title}</Fact>
          <Fact label={t('settings.about.slug')} mono>
            {instance.slug}
          </Fact>
          <Fact label={t('settings.about.instanceId')} mono>
            {instance.instanceId}
          </Fact>
          <Fact label={t('settings.about.schema')}>{format.number(instance.dbSchemaVersion)}</Fact>
        </Facts>
      </SettingsCard>
    </div>
  );
}

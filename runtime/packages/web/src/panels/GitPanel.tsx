import { Icon } from '../components/Icon.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { useT } from '../i18n/context.ts';
import { PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

const SHORT_HASH = 7;

/**
 * The Git panel (04-ui.md 4.4.1): the branch, how many files are uncommitted, a STOP file alert and the last three commits. When
 * the folder is not a repository, or Git cannot be run, it says that instead of showing empty facts.
 */
export function GitPanel({ data }: PanelBodyProps<'git'>) {
  const t = useT();

  let branch: string;
  if (data.branch !== null) branch = data.branch;
  else if (data.detached && data.headOid !== null)
    branch = t('panels.git.detached', { oid: data.headOid.slice(0, SHORT_HASH) });
  else branch = t('panels.git.noBranch');

  const stopFile = data.stopFile ? (
    <p className="panel-alert" role="status">
      <Icon name="alert" />
      <span>{t('panels.git.stopFile')}</span>
    </p>
  ) : null;

  if (data.repoState !== 'ok') {
    return (
      <div className="panel-git">
        {stopFile}
        <PanelNote>{t(`panels.git.state.${data.repoState}`)}</PanelNote>
      </div>
    );
  }

  return (
    <div className="panel-git">
      {stopFile}
      <p className="panel-git__branch">
        <Icon name="git-branch" />
        <span className="sr-only">{t('panels.git.branch')}</span>
        <span className="mono" title={branch}>
          {branch}
        </span>
      </p>
      <p className="panel-git__dirty" data-dirty={data.dirty === null ? undefined : String(data.dirty > 0)}>
        {data.dirty === null ? t('panels.git.uncommittedUnknown') : t('panels.git.uncommitted', { count: data.dirty })}
      </p>
      <h3 className="panel-section__title">{t('panels.git.commits')}</h3>
      {data.commits.length === 0 ? (
        <PanelNote>{t('panels.git.noCommits')}</PanelNote>
      ) : (
        <ul className="panel-commits">
          {data.commits.map((commit) => (
            <li key={commit.hash} className="panel-commit">
              <span className="panel-commit__hash mono">{commit.hash.slice(0, SHORT_HASH)}</span>
              <span className="panel-commit__subject" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="panel-commit__time muted">
                <RelativeTime iso={commit.at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

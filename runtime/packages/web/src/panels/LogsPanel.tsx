import type { PanelDataMap } from '@mcs/shared';
import { useRef } from 'react';

import { useFormat, useT } from '../i18n/context.ts';
import { useStickToBottom } from './ChainLogPanel.tsx';
import { PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

type LogFileData = PanelDataMap['logs']['files'][number];

/** A log written to less than this many seconds ago is "writing now"; an older one is idle. */
export const WRITING_NOW_S = 30;

function LogFile({ file }: { file: LogFileData }) {
  const t = useT();
  const format = useFormat();
  const ref = useRef<HTMLPreElement>(null);
  const text = file.tail.join('\n');
  const { onScroll } = useStickToBottom(ref, text);
  const writing = file.ageS < WRITING_NOW_S;
  return (
    <li className="panel-log">
      <div className="panel-log__head">
        <span className="panel-log__name mono" title={file.relPath}>
          {file.name}
        </span>
        <span
          className={`panel-log__state ${writing ? 'tone-running' : 'tone-idle'}`}
          data-writing={writing ? 'true' : 'false'}
        >
          <span className={`state-dot ${writing ? 'state-dot--pulse' : 'state-dot--solid'}`} aria-hidden="true" />
          <span>{writing ? t('panels.logs.writing') : t('panels.logs.idle', { age: format.age(file.ageS) })}</span>
        </span>
        <span className="panel-log__size muted">{format.bytes(file.sizeBytes)}</span>
      </div>
      {file.tail.length === 0 ? (
        <PanelNote>{t('panels.logs.noLines')}</PanelNote>
      ) : (
        <pre
          ref={ref}
          className="panel-tail mono"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling text region must take focus so that a keyboard user can scroll it (04-ui.md 4.4.1)
          tabIndex={0}
          role="region"
          aria-label={t('panels.logs.tail', { name: file.name })}
          onScroll={onScroll}
        >
          {text}
        </pre>
      )}
    </li>
  );
}

/**
 * The Logs panel (04-ui.md 4.4.1): the newest log files of the workspace, each with whether it is being written to right now,
 * its size and its last lines. The lines are text and are never interpreted.
 */
export function LogsPanel({ data }: PanelBodyProps<'logs'>) {
  const t = useT();
  const format = useFormat();
  if (data.files.length === 0) return <PanelNote>{t('panels.logs.empty')}</PanelNote>;
  return (
    <div className="panel-logs">
      <ul className="panel-logs__list">
        {data.files.map((file) => (
          <LogFile key={file.relPath} file={file} />
        ))}
      </ul>
      {data.matchedFiles > data.files.length ? (
        <p className="panel-meta muted">
          {t('panels.logs.more', { shown: format.number(data.files.length), total: format.number(data.matchedFiles) })}
        </p>
      ) : null}
    </div>
  );
}

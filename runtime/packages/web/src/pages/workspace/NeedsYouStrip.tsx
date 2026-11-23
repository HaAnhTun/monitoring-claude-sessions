// The "Needs you" strip of the Workspace (ADR 0107, design attention-trust 4.2): above the filter of the project column, the
// sessions a person should look at now. First those that cannot go on (a permission, a question, a terminal that never
// linked), then those that failed or finished and were not looked at yet; five rows at most, then "and N more". A row says its
// level in a word with a dot (never colour alone), a name and why. The name is the terminal, or for a session that is no
// terminal the title the person allows, else its short id: never the label of a terminal, a path or text of the registry.
//
// Props only. With nothing to show the component renders nothing at all (no empty box), so a column where no session needs
// the person keeps its measurements. The list below is never reordered: the strip is a separate, sorted copy.
import type { AttentionLevel } from '@mcs/shared';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import type { AttentionItem } from '../../lib/attention-rows.ts';
import { isAttentionLevel, titleOf, type StripModel, type TitleMode } from '../../lib/workspace-attention.ts';

type StripLevel = Extract<AttentionLevel, 'needs_you' | 'failed' | 'done'>;

const LEVEL_DISPLAY = {
  needs_you: { tone: 'tone-waiting', dot: 'ring', labelKey: 'workspace.attention.level.needs_you' },
  failed: { tone: 'tone-failed', dot: 'solid', labelKey: 'workspace.attention.level.failed' },
  done: { tone: 'tone-completed', dot: 'solid', labelKey: 'workspace.attention.level.done' },
} as const satisfies Record<StripLevel, { tone: string; dot: 'ring' | 'solid'; labelKey: MessageKey }>;

/** A level as a dot and words, in the tones of the state badge. `children` replaces the plain word (the folder chip adds a count). */
export function AttentionBadge({
  level,
  className,
  children,
}: {
  level: StripLevel;
  className?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const display = LEVEL_DISPLAY[level];
  const classes = ['badge', 'badge--state', 'badge--sm', display.tone];
  if (className !== undefined) classes.push(className);
  return (
    <span className={classes.join(' ')} data-attention-level={level}>
      <span className={`state-dot state-dot--${display.dot}`} aria-hidden="true" />
      <span className="badge__word">{children ?? t(display.labelKey)}</span>
    </span>
  );
}

type ReasonKey = `workspace.attention.reason.${'permission' | 'question' | 'notLinked' | 'done' | 'failed'}`;

function reasonKeyOf(item: AttentionItem): ReasonKey {
  if (item.level === 'failed') return 'workspace.attention.reason.failed';
  if (item.level === 'done') return 'workspace.attention.reason.done';
  if (item.cls.reason === 'permission') return 'workspace.attention.reason.permission';
  if (item.cls.reason === 'not_linked') return 'workspace.attention.reason.notLinked';
  return 'workspace.attention.reason.question';
}

interface RowProps {
  item: AttentionItem;
  level: StripLevel;
  titles: TitleMode;
  onMarkSeen: (keys: readonly string[]) => void;
  onNavigate?: (() => void) | undefined;
}

function StripRow({ item, level, titles, onMarkSeen, onNavigate }: RowProps) {
  const t = useT();
  const title = item.terminal === null ? titleOf(item, titles) : null;
  const plainName = item.terminal ?? title ?? (item.sessionId ?? '').slice(0, 8);
  const content = (
    <>
      <AttentionBadge level={level} />
      <span className="workspace-strip__name" title={title ?? undefined}>
        {item.terminal === null && title !== null ? <ServerText>{title}</ServerText> : plainName}
      </span>
      <span className="workspace-strip__reason">{t(reasonKeyOf(item))}</span>
    </>
  );
  return (
    <li className="workspace-strip__row" data-level={level}>
      {item.terminal !== null ? (
        <Link
          to={{ pathname: '/', search: `?session=${encodeURIComponent(item.terminal)}` }}
          state={{ focusTerminal: true }}
          className="workspace-strip__link"
          onClick={onNavigate}
        >
          {content}
        </Link>
      ) : (
        <Link
          to={`/sessions/${encodeURIComponent(item.sessionId ?? '')}`}
          className="workspace-strip__link"
          onClick={onNavigate}
        >
          {content}
        </Link>
      )}
      {level === 'needs_you' ? null : (
        <Button
          variant="quiet"
          aria-label={t('workspace.attention.markSeen.name', { name: plainName })}
          onClick={() => {
            onMarkSeen([item.key]);
          }}
        >
          {t('workspace.attention.markSeen')}
        </Button>
      )}
    </li>
  );
}

export interface NeedsYouStripProps {
  /** `stripOf(items)`: the rows in strip order, the full count and what "Dismiss all" marks. */
  model: StripModel;
  /** The preference `workspaceTitles`: which title may name a session that is no terminal. */
  titles: TitleMode;
  /** "Mark as seen" (one key) and "Dismiss all" (every failed or finished row). */
  onMarkSeen: (keys: readonly string[]) => void;
  /** Called after a click on a row (the overlay of the list closes on a selection). */
  onNavigate?: (() => void) | undefined;
}

export function NeedsYouStrip({ model, titles, onMarkSeen, onNavigate }: NeedsYouStripProps) {
  const t = useT();
  const headingId = useId();
  if (model.total === 0) return null;
  return (
    <section className="workspace-strip" aria-labelledby={headingId}>
      <div className="workspace-strip__head">
        <h3 id={headingId} className="workspace-strip__heading">
          {t('workspace.attention.heading', { count: model.total })}
        </h3>
        {model.dismissable.length === 0 ? null : (
          <Button
            variant="quiet"
            onClick={() => {
              onMarkSeen(model.dismissable);
            }}
          >
            {t('workspace.attention.dismissAll')}
          </Button>
        )}
      </div>
      <ul className="plain workspace-strip__rows">
        {model.rows.map((item) =>
          isAttentionLevel(item.level) ? (
            <StripRow
              key={item.key}
              item={item}
              level={item.level}
              titles={titles}
              onMarkSeen={onMarkSeen}
              onNavigate={onNavigate}
            />
          ) : null,
        )}
      </ul>
      {model.more > 0 ? (
        <p className="muted small workspace-strip__more">{t('workspace.attention.more', { count: model.more })}</p>
      ) : null}
    </section>
  );
}

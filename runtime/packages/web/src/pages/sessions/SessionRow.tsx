import type { SessionSummary } from '@mcs/shared';

import { TagBadge } from '../../components/TagBadge.tsx';
import { useT } from '../../i18n/context.ts';

export interface SessionRowProps {
  session: SessionSummary;
  /** Draw the model on a second line (the list calls for it when the sessions do not all use the same model). */
  showModel?: boolean;
}

const SHORT_ID_LENGTH = 8;

/** The models of a session as one line; empty when the monitor saw none. */
export function modelLineOf(session: SessionSummary): string {
  if (session.models.length > 0) return session.models.join(', ');
  return session.lastModel ?? '';
}

/** Whether the sessions of a list differ in their model, so that the model is worth a line of each session. */
export function modelsDiffer(sessions: readonly SessionSummary[]): boolean {
  const lines = new Set<string>();
  for (const session of sessions) {
    lines.add(modelLineOf(session));
    if (lines.size > 1) return true;
  }
  return false;
}

/**
 * What identifies a session in the list: its label, the start of its id and, when the list calls for it, its model on a line of
 * its own. The tag says why a session is shown although no project rule matched it. The link to the session is made around this
 * content by the table (the Session column is the link column).
 */
export function SessionRow({ session, showModel = false }: SessionRowProps) {
  const t = useT();
  const model = showModel ? modelLineOf(session) : '';
  return (
    <span className="session-cell">
      <span className="session-cell__main">
        <span className="session-cell__label" title={session.label}>
          {session.label}
        </span>
        <span className="mono session-cell__id" title={session.id}>
          {session.id.slice(0, SHORT_ID_LENGTH)}
        </span>
        {session.matched ? null : (
          <TagBadge tone="neutral" tip={t('sessions.session.notInList.tip')}>
            {t('sessions.session.notInList')}
          </TagBadge>
        )}
      </span>
      {model === '' ? null : (
        <span className="session-cell__model" title={model}>
          {model}
        </span>
      )}
    </span>
  );
}

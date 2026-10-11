import type { SessionSummary } from '@mcs/shared';

import { TagBadge } from '../../components/TagBadge.tsx';

export interface SessionRowProps {
  session: SessionSummary;
}

const SHORT_ID_LENGTH = 8;

/**
 * What identifies a session in the list: its label, the start of its id and the tags that explain why it is shown. The
 * link to the session is made around this content by the table (the Session column is the link column).
 */
export function SessionRow({ session }: SessionRowProps) {
  return (
    <span className="session-cell">
      <span className="session-cell__label">{session.label}</span>{' '}
      <span className="mono session-cell__id" title={session.id}>
        {session.id.slice(0, SHORT_ID_LENGTH)}
      </span>
      {session.matched ? null : (
        <>
          {' '}
          <TagBadge tone="neutral" tip="No project rule matched this session">
            not in list
          </TagBadge>
        </>
      )}
    </span>
  );
}

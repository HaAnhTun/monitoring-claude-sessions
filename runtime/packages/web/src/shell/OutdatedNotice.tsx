import type { TerminalState } from '@mcs/shared';
import { skipToken, useQuery } from '@tanstack/react-query';

import { CopyButton } from '../components/CopyButton.tsx';
import { Icon } from '../components/Icon.tsx';
import { useHealth } from '../data/hooks/useHealth.ts';
import { useIid, useInstance } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { useT } from '../i18n/context.ts';

/** Stands in for the command while the sentence is translated; the command itself is inserted afterwards as code. */
const COMMAND_SLOT = '@@command@@';

const FORCE_FLAG = '--force';

/**
 * The running terminals the page already knows about, without a request: an observer with `skipToken` reads the cached answer
 * of `GET /terminal/state` (the Workspace and its events keep it fresh while it is open) and never fetches it.
 */
function useCachedTerminalCount(): number {
  const iid = useIid();
  const cached = useQuery<TerminalState, Error, number>({
    queryKey: qk.terminalState(iid),
    queryFn: skipToken,
    select: (state) => state.sessions.length,
  });
  return cached.data ?? 0;
}

/**
 * The note of a user instance whose running code is older than the files on disk (design 04 4.7, TC-UI-13): it says so, names
 * the terminals a restart would end, and offers the command to copy. There is no restart button: nothing about the lifecycle
 * goes through HTTP (ADR 0099). With running terminals the command is the forced one, because a plain restart is refused while
 * a terminal runs; the flag is added here, not in the catalogue.
 */
export function OutdatedNotice() {
  const t = useT();
  const instance = useInstance().data;
  const outdated = useHealth().data?.runtime.outdated === true;
  const running = useCachedTerminalCount();
  if (instance?.kind !== 'user' || !outdated) return null;

  const base = instance.commands.restart;
  const command = running > 0 && !base.includes(FORCE_FLAG) ? `${base} ${FORCE_FLAG}` : base;
  const [before = '', after = ''] = t('shell.outdated.body', { command: COMMAND_SLOT }).split(COMMAND_SLOT);
  return (
    <div className="notice" role="note">
      <Icon name="info" />
      <span>
        {before}
        <code className="mono">{command}</code>
        {after}
        {running > 0 ? ` ${t('shell.outdated.terminals', { count: running })}` : null}
      </span>
      <CopyButton text={command} label={t('shell.outdated.copy')} />
    </div>
  );
}

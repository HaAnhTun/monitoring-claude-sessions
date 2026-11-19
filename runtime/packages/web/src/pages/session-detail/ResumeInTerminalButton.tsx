// "Resume in terminal" on the session page (design 04 6.5): the way from a monitored session to a terminal that runs it. It exists
// only on the user instance, for a browser that holds the session cookie, on a system whose terminal can resume. When a terminal of
// this app already runs the session, the same place says "Open its terminal" and links to it instead. Where the host can open a
// window of the person's own terminal (`capabilities.nativeOpen`, CAW-145) a second button does that, with the same dialog.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '../../components/Button.tsx';
import { Icon } from '../../components/Icon.tsx';
import { useAuthSession } from '../../data/hooks/useAuth.ts';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useTerminalState } from '../../data/hooks/useTerminalState.ts';
import { useT } from '../../i18n/context.ts';
import { ResumeDialog } from '../workspace/ActionDialogs.tsx';

export interface ResumeInTerminalButtonProps {
  /** The monitored session of the page. */
  sessionId: string;
}

/** Nothing is asked of the server on a task instance: the terminal exists on the user instance only. */
export function ResumeInTerminalButton({ sessionId }: ResumeInTerminalButtonProps) {
  const instance = useInstance();
  if (instance.data?.kind !== 'user') return null;
  return <ResumeControl sessionId={sessionId} />;
}

function ResumeControl({ sessionId }: ResumeInTerminalButtonProps) {
  const t = useT();
  const navigate = useNavigate();
  const auth = useAuthSession();
  // This page has no events stream, so the list is refreshed at the slow rate: it only decides which of two labels to show.
  const terminals = useTerminalState({ eventsOpen: true });
  const [open, setOpen] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);

  const view = terminals.data;
  if (auth.data?.authenticated !== true || view === undefined) return null;
  if (!view.capabilities.available || !view.capabilities.resume) return null;

  const running = view.sessions.find((session) => session.link.sessionId === sessionId);
  if (running !== undefined) {
    return (
      <span className="session-header__resume">
        <Link className="btn" to={{ pathname: '/', search: `?session=${encodeURIComponent(running.name)}` }}>
          <Icon name="terminal" />
          {t('detail.resume.open')}
        </Link>
      </span>
    );
  }
  return (
    <span className="session-header__resume">
      <Button
        icon="terminal"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('detail.resume.action')}
      </Button>
      {view.capabilities.nativeOpen === true ? (
        <Button
          icon="external"
          onClick={() => {
            setNativeOpen(true);
          }}
        >
          {t('detail.resume.native')}
        </Button>
      ) : null}
      {view.capabilities.nativeOpen === true ? (
        <ResumeDialog
          sessionId={nativeOpen ? sessionId : null}
          target="native"
          onCancel={() => {
            setNativeOpen(false);
          }}
        />
      ) : null}
      <ResumeDialog
        sessionId={open ? sessionId : null}
        onCancel={() => {
          setOpen(false);
        }}
        onResumed={(session) => {
          setOpen(false);
          void navigate({ pathname: '/', search: `?session=${encodeURIComponent(session.name)}` });
        }}
      />
    </span>
  );
}

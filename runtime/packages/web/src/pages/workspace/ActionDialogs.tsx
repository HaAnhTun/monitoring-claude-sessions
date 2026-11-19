// The questions the Workspace asks before it starts, stops or resumes a terminal (design 04 6.4). Each dialog owns its request: it
// shows the failure inside the box and stays open, and tells the page only what the page has to do next (select the new session,
// leave the stopped one). The shell of every dialog is `ConfirmDialog`, so the focus, Escape and the backdrop behave the same way.
import type { ResumeEligibility, ResumeReason } from '@mcs/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { describeApiError } from '../../data/api-errors.ts';
import {
  useOpenNativeTerminal,
  useResumeEligibility,
  useResumeTerminalSession,
  useStartInFolder,
  useStopTerminalSession,
} from '../../data/hooks/useTerminalActions.ts';
import { useT } from '../../i18n/context.ts';
import type { MessageKey, TFunction } from '../../i18n/types.ts';
import { useAnnounce } from '../../state/announcer.tsx';
import type { LiveSession } from '../../lib/workspace-view.ts';

type FailureKey =
  'workspace.error.create' | 'workspace.error.stop' | 'workspace.error.resume' | 'workspace.error.native';

/** What a failed request says inside the dialog: the sentence of the action with the reason of the failure. */
function failureText(t: TFunction, key: FailureKey, error: Error | null): string | null {
  if (error === null) return null;
  if (key === 'workspace.error.create' && describeApiError(error, t) === undefined) {
    return t('workspace.error.createPlain');
  }
  return t(key, { detail: describeApiError(error, t) ?? error.name });
}

/** The folder or session a dialog is about: the name in strong text and the path under it, muted. */
function Subject({ name, path }: { name: string; path: string }) {
  return (
    <p className="dialog__subject">
      <strong className="dialog__name">{name}</strong>
      <span className="dialog__path muted">{path}</span>
    </p>
  );
}

// ---- a new session ---------------------------------------------------------------------------------------------------------

export interface NewSessionTarget {
  name: string;
  path: string;
  /** A row of the folder list: it is known. A folder from the picker is added first. */
  known: boolean;
}

export interface NewSessionDialogProps {
  /** The folder to start in; `null` keeps the dialog closed. */
  target: NewSessionTarget | null;
  onCancel: () => void;
  onStarted: (session: LiveSession) => void;
}

/** "Start a new session in this folder?" (MTOP's confirmation). */
export function NewSessionDialog({ target, onCancel, onStarted }: NewSessionDialogProps) {
  const t = useT();
  const { start, isPending, error, reset } = useStartInFolder();
  const open = target !== null;
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  return (
    <ConfirmDialog
      open={open}
      title={t('workspace.dialog.new.title')}
      confirmLabel={isPending ? t('workspace.dialog.busy') : t('workspace.dialog.new.confirm')}
      cancelLabel={t('workspace.dialog.cancel')}
      busy={isPending}
      error={failureText(t, 'workspace.error.create', error)}
      onCancel={onCancel}
      onConfirm={() => {
        if (target === null) return;
        start(target.path, { known: target.known }).then(onStarted, () => undefined);
      }}
    >
      {target === null ? null : (
        <>
          <p>{t('workspace.dialog.new.body')}</p>
          <Subject name={target.name} path={target.path} />
        </>
      )}
    </ConfirmDialog>
  );
}

// ---- stop ------------------------------------------------------------------------------------------------------------------

export interface StopSessionDialogProps {
  /** The session to stop; `null` keeps the dialog closed. */
  session: Pick<LiveSession, 'name' | 'path'> | null;
  onCancel: () => void;
  onStopped: (name: string) => void;
}

/** "The claude process of this session will stop" (danger). */
export function StopSessionDialog({ session, onCancel, onStopped }: StopSessionDialogProps) {
  const t = useT();
  const stop = useStopTerminalSession();
  const { mutateAsync, reset, isPending, error } = stop;
  const open = session !== null;
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  return (
    <ConfirmDialog
      open={open}
      tone="danger"
      title={t('workspace.dialog.stop.title')}
      confirmLabel={isPending ? t('workspace.dialog.busy') : t('workspace.dialog.stop.confirm')}
      cancelLabel={t('workspace.dialog.cancel')}
      busy={isPending}
      error={failureText(t, 'workspace.error.stop', error)}
      onCancel={onCancel}
      onConfirm={() => {
        if (session === null) return;
        const { name } = session;
        mutateAsync({ name }).then(
          () => {
            onStopped(name);
          },
          () => undefined,
        );
      }}
    >
      {session === null ? null : (
        <>
          <p>{t('workspace.dialog.stop.body')}</p>
          <Subject name={session.name} path={session.path} />
        </>
      )}
    </ConfirmDialog>
  );
}

// ---- resume ----------------------------------------------------------------------------------------------------------------

const REASON_KEYS = {
  transcript_gone: 'workspace.resume.reason.transcript_gone',
  folder_missing: 'workspace.resume.reason.folder_missing',
  folder_unknown: 'workspace.resume.reason.folder_unknown',
  live_in_terminal: 'workspace.resume.reason.live_in_terminal',
  live_elsewhere: 'workspace.resume.reason.live_elsewhere',
} as const satisfies Record<ResumeReason, MessageKey>;

/** What the answer of the server lets the person do. */
type Outcome =
  /** Resume it as it is. */
  | { kind: 'resume' }
  /** Open somewhere else: only a copy is safe. */
  | { kind: 'copy' }
  /** A terminal of this app already runs it. */
  | { kind: 'in-terminal'; terminal: string | null }
  | { kind: 'refused'; reason: ResumeReason | null };

/** The order of the checks of design 04 6.4: a terminal of this app, another program, then the plain yes or no. */
export function outcomeOf(e: ResumeEligibility): Outcome {
  if (e.reason === 'live_in_terminal') return { kind: 'in-terminal', terminal: e.liveTerminal };
  if (e.liveElsewhere)
    return e.forkAllowed ? { kind: 'copy' } : { kind: 'refused', reason: e.reason ?? 'live_elsewhere' };
  if (e.allowed) return { kind: 'resume' };
  return { kind: 'refused', reason: e.reason };
}

export interface ResumeDialogProps {
  /** The monitored session to resume; `null` keeps the dialog closed. */
  sessionId: string | null;
  onCancel: () => void;
  /** The session of the terminal the app started (target `app`); a native window is not one, so it is not called for `native`. */
  onResumed?: (session: LiveSession) => void;
  /**
   * Where the session runs: a new terminal of this app (default), or a window of the person's own terminal (CAW-145). The check,
   * the refusals and the words about a session open elsewhere are the same; the title, the confirm buttons and the request differ.
   * A native window closes the dialog and is announced; nothing navigates.
   */
  target?: 'app' | 'native';
}

/**
 * "Resume this session in a terminal?": asks the server first (`sessionResume`) and shows what it said: resume, resume a copy,
 * show the terminal that already runs it, or why it cannot be resumed.
 */
export function ResumeDialog({ sessionId, onCancel, onResumed, target = 'app' }: ResumeDialogProps) {
  const t = useT();
  const announce = useAnnounce();
  const native = target === 'native';
  const eligibility = useResumeEligibility(sessionId);
  const resume = useResumeTerminalSession();
  const openNative = useOpenNativeTerminal();
  const action = native ? openNative : resume;
  const { reset, isPending, error } = action;
  const open = sessionId !== null;
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const answer = eligibility.data;
  const outcome = answer === undefined ? null : outcomeOf(answer);
  const fork = outcome?.kind === 'copy';
  const canConfirm = outcome?.kind === 'resume' || outcome?.kind === 'copy';
  const confirmLabel = ((): string | undefined => {
    if (!canConfirm) return undefined;
    if (isPending) return t('workspace.dialog.busy');
    if (native) return fork ? t('workspace.dialog.native.fork') : t('workspace.dialog.native.confirm');
    return fork ? t('workspace.dialog.resume.fork') : t('workspace.dialog.resume.confirm');
  })();
  const failureKey: FailureKey = native ? 'workspace.error.native' : 'workspace.error.resume';
  const failure =
    failureText(t, failureKey, error) ?? (eligibility.isError ? failureText(t, failureKey, eligibility.error) : null);

  return (
    <ConfirmDialog
      open={open}
      title={native ? t('workspace.dialog.native.title') : t('workspace.dialog.resume.title')}
      {...(confirmLabel === undefined ? {} : { confirmLabel })}
      cancelLabel={t('workspace.dialog.cancel')}
      busy={isPending}
      error={failure}
      onCancel={onCancel}
      onConfirm={() => {
        if (sessionId === null || !canConfirm) return;
        if (native) {
          openNative.mutateAsync({ sessionId, fork }).then(
            () => {
              announce(t('workspace.dialog.native.done'));
              onCancel();
            },
            () => undefined,
          );
          return;
        }
        resume.mutateAsync({ sessionId, fork }).then(onResumed, () => undefined);
      }}
    >
      {answer === undefined || outcome === null ? (
        eligibility.isError ? null : (
          <p role="status" className="muted">
            {t('workspace.dialog.resume.checking')}
          </p>
        )
      ) : (
        <ResumeAnswer answer={answer} outcome={outcome} native={native} onShowTerminal={onCancel} />
      )}
    </ConfirmDialog>
  );
}

interface ResumeAnswerProps {
  answer: ResumeEligibility;
  outcome: Outcome;
  /** The window of the person's own terminal: the body says that, the rest of the words are the same. */
  native: boolean;
  /** The person went to the terminal that runs the session: the dialog has nothing left to ask. */
  onShowTerminal: () => void;
}

function ResumeAnswer({ answer, outcome, native, onShowTerminal }: ResumeAnswerProps) {
  const t = useT();
  const redirect =
    answer.redirectTo === null ? null : <p className="dialog__note muted">{t('workspace.dialog.resume.redirect')}</p>;
  switch (outcome.kind) {
    case 'resume':
      return (
        <>
          <p>{t(native ? 'workspace.dialog.native.body' : 'workspace.dialog.resume.body')}</p>
          {answer.folder === null ? null : <p className="dialog__path muted">{answer.folder.path}</p>}
          {redirect}
        </>
      );
    case 'copy':
      return (
        <>
          <p>{t('workspace.dialog.resume.elsewhere')}</p>
          {answer.folder === null ? null : <p className="dialog__path muted">{answer.folder.path}</p>}
          {redirect}
        </>
      );
    case 'in-terminal':
      return (
        <>
          <p>{t('workspace.dialog.resume.inTerminal')}</p>
          {outcome.terminal === null ? null : (
            <p>
              <Link
                to={{ pathname: '/', search: `?session=${encodeURIComponent(outcome.terminal)}` }}
                onClick={onShowTerminal}
              >
                {t('workspace.dialog.resume.show')}
              </Link>
            </p>
          )}
        </>
      );
    case 'refused':
      return (
        <p>
          {outcome.reason === null
            ? t('error.handling.notResumable')
            : t('workspace.dialog.resume.refused', { reason: t(REASON_KEYS[outcome.reason]) })}
        </p>
      );
  }
}

// ---- a folder by path ------------------------------------------------------------------------------------------------------

export interface FolderPathDialogProps {
  open: boolean;
  onCancel: () => void;
  onStarted: (session: LiveSession) => void;
}

/** The folder picker is not available here (or answered "unavailable"): type the path of the folder to start in. */
export function FolderPathDialog({ open, onCancel, onStarted }: FolderPathDialogProps) {
  const t = useT();
  const { start, isPending, error, reset } = useStartInFolder();
  const [path, setPath] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  // What was typed is forgotten when the dialog closes (adjusting state while rendering, not in an effect).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setPath('');
  }
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  const ready = path.trim() !== '';
  const submit = (): void => {
    if (!ready || isPending) return;
    start(path).then(onStarted, () => undefined);
  };
  return (
    <ConfirmDialog
      open={open}
      title={t('workspace.dialog.folder.title')}
      confirmLabel={isPending ? t('workspace.dialog.busy') : t('workspace.dialog.folder.confirm')}
      confirmDisabled={!ready}
      cancelLabel={t('workspace.dialog.cancel')}
      busy={isPending}
      error={failureText(t, 'workspace.error.create', error)}
      initialFocus={fieldRef}
      onCancel={onCancel}
      onConfirm={submit}
    >
      <p>{t('workspace.dialog.folder.body')}</p>
      <div className="dialog__field">
        <label htmlFor={fieldId}>{t('workspace.dialog.folder.label')}</label>
        <input
          ref={fieldRef}
          id={fieldId}
          className="input"
          type="text"
          value={path}
          placeholder={t('workspace.dialog.folder.placeholder')}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error === null ? undefined : true}
          onChange={(event) => {
            setPath(event.target.value);
            if (error !== null) reset();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
      </div>
    </ConfirmDialog>
  );
}

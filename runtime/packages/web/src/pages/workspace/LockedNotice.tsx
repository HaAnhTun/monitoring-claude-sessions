// The locked state of the Workspace (design 04 4.5 and 8.1): this browser holds no session of the terminal side, so the pane asks
// for the access link. The paste field takes the whole printed link or the bare code; anything else sends nothing. A code is
// never kept: the field is cleared on submit, the flow keeps it only for the one request. The monitor pages work without it.
import { useId, useState, type Ref } from 'react';

import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { readAccessInput, type AccessFlow, type AccessOutcome } from '../../data/access-flow.ts';
import { describeApiError } from '../../data/api-errors.ts';
import { useT } from '../../i18n/context.ts';
import type { TFunction } from '../../i18n/types.ts';

/** The command that prints a new access link. A command of the tool, not a sentence: it is the same in every language. */
export const ACCESS_COMMAND = 'caw open';

/** Stands in for the command while the sentence is translated; the command itself is inserted afterwards as code. */
const COMMAND_SLOT = '';

export interface LockedNoticeProps {
  /** Where the access flow is (anything but `idle` and `granted` locks the pane). */
  outcome: AccessOutcome;
  flow: AccessFlow;
  headingRef: Ref<HTMLHeadingElement>;
}

/** The sentence that follows an outcome, or `null` for a state that needs none. */
function outcomeLine(outcome: AccessOutcome, t: TFunction): string | null {
  switch (outcome.kind) {
    case 'cookie-not-kept':
      return t('access.error.cookie');
    case 'invalid':
      return t('access.error.invalid', { command: ACCESS_COMMAND });
    case 'rate-limited':
      return t('access.error.rateLimited', { seconds: Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)) });
    case 'failed':
      return t('access.error.failed', { detail: describeApiError(outcome.error, t) ?? outcome.error.name });
    case 'idle':
    case 'exchanging':
    case 'granted':
      return null;
  }
}

/** The sentence of the locked state with `{command}` in it, the command as code. */
function LockedBody() {
  const t = useT();
  const [before = '', after = ''] = t('access.locked.body', { command: COMMAND_SLOT }).split(COMMAND_SLOT);
  return (
    <p>
      {before}
      <code className="mono">{ACCESS_COMMAND}</code>
      {after}
    </p>
  );
}

export function LockedNotice({ outcome, flow, headingRef }: LockedNoticeProps) {
  const t = useT();
  const fieldId = useId();
  const messageId = useId();
  const [value, setValue] = useState('');
  const [badFormat, setBadFormat] = useState(false);
  const checking = outcome.kind === 'exchanging';
  const line = badFormat ? t('access.error.format') : outcomeLine(outcome, t);

  function submit(): void {
    if (checking) return;
    const code = readAccessInput(value);
    if (code === null) {
      setBadFormat(true);
      return;
    }
    setBadFormat(false);
    // the field is emptied at once: the code lives only in this request
    setValue('');
    void flow.submit(code);
  }

  return (
    <div className="workspace-locked">
      <EmptyState
        icon="terminal"
        title={t('access.locked.title')}
        headingLevel={1}
        titleRef={headingRef}
        announce={false}
      >
        <LockedBody />
        <form
          className="workspace-locked__form"
          method="post"
          action="/"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={fieldId}>{t('access.field.label')}</label>
          <div className="workspace-locked__row">
            <input
              id={fieldId}
              className="input"
              type="password"
              value={value}
              autoComplete="one-time-code"
              spellCheck={false}
              aria-invalid={line === null || checking ? undefined : true}
              aria-describedby={line === null ? undefined : messageId}
              onChange={(event) => {
                setValue(event.target.value);
                if (badFormat) setBadFormat(false);
              }}
            />
            <Button type="submit" variant="primary" disabled={checking || value.trim() === ''}>
              {checking ? t('access.field.checking') : t('access.field.submit')}
            </Button>
          </div>
          <p id={messageId} className="workspace-locked__message" role="alert">
            {line}
          </p>
        </form>
        <p className="muted">{t('access.locked.monitor')}</p>
      </EmptyState>
    </div>
  );
}

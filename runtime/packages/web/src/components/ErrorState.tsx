import type { ReactNode } from 'react';

import { describeApiError } from '../data/api-errors.ts';
import { useFormat, useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';

export type ErrorStateKind = 'load' | 'refresh' | 'not-found' | 'crash' | 'contract';

/** What failed, as a catalogue entry: `error.subject.sessions` reads "sessions". */
export type SubjectKey = Extract<MessageKey, `error.subject.${string}`>;

export interface ErrorStateProps {
  kind: ErrorStateKind;
  /** Any Error. An `ApiError` is worded from its `info` through the catalogue; another error by its own message. */
  error?: Error | undefined;
  size?: 'page' | 'block' | 'inline';
  /** Shows the retry button ("Reload view" for a crash). */
  onRetry?: (() => void) | undefined;
  /** `refresh` kind: epoch milliseconds of the data still shown. */
  lastGoodAt?: number | null | undefined;
  /** What failed (an `error.subject.*` message); defaults to "data". */
  subjectKey?: SubjectKey | undefined;
  /** Deprecated: plain English text of what failed; use `subjectKey`. Kept until the pages that pass it are converted. */
  subject?: string | undefined;
  /** Extra actions (links, copy buttons) rendered after the retry button. */
  children?: ReactNode;
}

export function ErrorState({
  kind,
  error,
  size = 'block',
  onRetry,
  lastGoodAt,
  subjectKey,
  subject,
  children,
}: ErrorStateProps) {
  const t = useT();
  const format = useFormat();
  const what = subjectKey === undefined ? (subject ?? t('error.subject.data')) : t(subjectKey);
  const detail = describeApiError(error, t);
  let text: string;
  switch (kind) {
    case 'load':
      text =
        detail === undefined ? t('error.load', { subject: what }) : t('error.loadDetail', { subject: what, detail });
      break;
    case 'refresh': {
      const age = lastGoodAt === null || lastGoodAt === undefined ? '' : format.relative(lastGoodAt);
      const when = age === '' ? t('time.earlier') : age;
      text =
        detail === undefined
          ? t('error.refresh', { subject: what, age: when })
          : t('error.refreshDetail', { subject: what, detail, age: when });
      break;
    }
    case 'not-found':
      text = t('error.sessionNotFound');
      break;
    case 'crash':
      text = t('common.viewFailed');
      break;
    case 'contract':
      text =
        detail === undefined
          ? t('error.contract', { subject: what })
          : t('error.contractDetail', { subject: what, detail });
      break;
  }
  // role="alert" only for a page-size load failure (04-ui.md 4.3); everything else is a polite status.
  const role = kind === 'load' && size === 'page' ? 'alert' : 'status';
  return (
    <div className={`state state--error state--${size}`} role={role} data-kind={kind}>
      <div className="state__title">
        <Icon name="alert" />
        <span>{text}</span>
      </div>
      {onRetry === undefined && children === undefined ? null : (
        <div className="state__actions">
          {onRetry === undefined ? null : (
            <Button icon="refresh" onClick={onRetry}>
              {kind === 'crash' ? t('common.reloadView') : t('common.retryNow')}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

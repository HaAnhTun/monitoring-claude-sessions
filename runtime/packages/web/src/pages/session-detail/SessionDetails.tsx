import type { SessionDetail } from '@mcs/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { CopyButton } from '../../components/CopyButton.tsx';
import { Disclosure } from '../../components/Disclosure.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import { boardDisplay } from '../../lib/lifecycle-display.ts';
import { stateEvidence } from '../../lib/state-evidence.ts';
import { AuditRefs } from './AuditRefs.tsx';

export interface SessionDetailsProps {
  session: SessionDetail;
}

const DETAILS_ID = 'session-details';

const LABEL_SOURCE_KEYS = {
  rule: 'detail.details.label.rule',
  custom_title: 'detail.details.label.custom_title',
  ai_title: 'detail.details.label.ai_title',
  first_prompt: 'detail.details.label.first_prompt',
  none: null,
} as const satisfies Readonly<Record<SessionDetail['labelSource'], MessageKey | null>>;

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'session-details__field session-details__field--wide' : 'session-details__field'}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function filled(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

/**
 * The rest of what the monitor knows about a session, closed until asked for (ADR 0073 decision 8): the whole id with a copy
 * button, the project, the models, the folder, the way the state was decided and the audit references. A field with nothing in it
 * is not drawn at all, so the list never holds a row of dashes. Every value is text; nothing from a transcript is read as markup.
 */
export function SessionDetails({ session }: SessionDetailsProps) {
  const t = useT();
  const format = useFormat();
  const state = session.state;
  const basis = stateEvidence(state, session.lastActivityAt, 0);
  const labelKey = LABEL_SOURCE_KEYS[session.labelSource];
  const models = session.models.length > 0 ? session.models.join(', ') : '';
  return (
    <Disclosure id={DETAILS_ID} label={t('detail.details')}>
      <dl className="session-details">
        <Field label={t('detail.details.sessionId')} wide>
          <span className="session-details__id">
            <span className="mono">{session.id}</span>
            <CopyButton compact text={session.id} label={t('detail.details.copyId')} />
          </span>
        </Field>
        {filled(session.projectLabel) ? (
          <Field label={t('detail.details.project')}>{session.projectLabel}</Field>
        ) : null}
        {session.matched ? null : <Field label={t('detail.details.projectRule')}>{t('detail.notInList.tip')}</Field>}
        {labelKey === null ? null : <Field label={t('detail.details.label')}>{t(labelKey)}</Field>}
        {session.workItems.length === 0 ? null : (
          <Field label={t('detail.details.workItems')}>
            <ul className="session-details__items">
              {session.workItems.map((item) => {
                const display = boardDisplay(item.state);
                return (
                  <li key={item.id}>
                    <Link to={`/sessions?task=${String(item.id)}`}>{item.title}</Link>{' '}
                    <TagBadge tone={display.tone}>{t(display.labelKey)}</TagBadge>
                  </li>
                );
              })}
            </ul>
          </Field>
        )}
        <Field label={t('detail.details.provider')}>{session.provider}</Field>
        {filled(session.ccVersion) ? <Field label={t('detail.details.version')}>{session.ccVersion}</Field> : null}
        {filled(session.entrypoint) ? <Field label={t('detail.details.entrypoint')}>{session.entrypoint}</Field> : null}
        {models === '' ? null : <Field label={t('detail.details.models')}>{models}</Field>}
        {filled(session.cwd) ? (
          <Field label={t('detail.details.cwd')} wide>
            <span className="mono">{session.cwd}</span>
          </Field>
        ) : null}
        {filled(session.gitBranch) ? (
          <Field label={t('detail.details.branch')}>
            <span className="mono">{session.gitBranch}</span>
          </Field>
        ) : null}
        {filled(session.permissionMode) ? (
          <Field label={t('detail.details.permission')}>{session.permissionMode}</Field>
        ) : null}
        <Field label={t('detail.details.started')}>{format.dateTime(session.startedAt)}</Field>
        {session.endedAt === null ? null : (
          <Field label={t('detail.details.ended')}>{format.dateTime(session.endedAt)}</Field>
        )}
        {filled(state.endReason) ? (
          <Field label={t('detail.details.endReason')}>
            <ServerText>{state.endReason}</ServerText>
          </Field>
        ) : null}
        <Field label={t('detail.details.stateBasis')}>
          {t('evidence.basisTip', { basis: t(basis.basisKey), confidence: t(basis.confidenceKey) })}
        </Field>
        {filled(state.rule) ? (
          <Field label={t('detail.details.stateRule')}>
            <span className="mono">{state.rule}</span>
          </Field>
        ) : null}
      </dl>
      <AuditRefs refs={session.auditRefs} />
    </Disclosure>
  );
}

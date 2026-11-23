// The Attention card of the display preferences (ADR 0107, design attention-trust 3.10): what this browser does when a session
// needs the person, failed or finished. The count in the tab title and the dot on the tab icon are on; the OS notification is
// off until the person turns it on, and the browser is asked for its permission only by the button here (a user gesture). One
// scope for all three; the delay; and which titles the Workspace shows. Everything is kept in this browser.
//
// The card is loaded lazily by `PreferencesForm`, and the code that touches `Notification` behind another dynamic import, so
// the first chunk of the page carries neither.
import { useEffect, useId, useState, type ReactNode } from 'react';

import { Button } from '../../components/Button.tsx';
import { useInstance } from '../../data/hooks/useInstance.ts';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';
import { ATTENTION_DELAY_MAX_SECONDS, attentionPrefsOf, type PrefsData } from '../../lib/prefs.ts';
import type { NotificationPermissionState } from '../../state/attention-env.ts';
import { usePrefs } from '../../state/prefs-store.ts';
import { SettingsCard } from './SettingsParts.tsx';

type Scope = PrefsData['attentionScope'];
type Titles = PrefsData['workspaceTitles'];

const SCOPES = [
  { value: 'here', labelKey: 'settings.attention.scope.here' },
  { value: 'all', labelKey: 'settings.attention.scope.all' },
] as const satisfies readonly { value: Scope; labelKey: MessageKey }[];

const TITLES = [
  { value: 'named', labelKey: 'settings.attention.titles.named' },
  { value: 'all', labelKey: 'settings.attention.titles.all' },
  { value: 'off', labelKey: 'settings.attention.titles.off' },
] as const satisfies readonly { value: Titles; labelKey: MessageKey }[];

const PERMISSION_KEYS = {
  default: 'settings.attention.permission.default',
  granted: 'settings.attention.permission.granted',
  denied: 'settings.attention.permission.denied',
  unsupported: 'settings.attention.permission.unsupported',
} as const satisfies Record<NotificationPermissionState, MessageKey>;

/** How the card reads and asks for the permission of the browser; a test replaces it. */
export interface NotificationPermissionEnv {
  read(): Promise<NotificationPermissionState>;
  /** Shows the question of the browser: call it only from a click. */
  request(): Promise<NotificationPermissionState>;
}

const browserPermissionEnv: NotificationPermissionEnv = {
  read: async () => (await import('../../state/attention-env.ts')).notificationPermission(),
  request: async () => (await import('../../state/attention-env.ts')).requestNotificationPermission(),
};

function Choice(props: { name: string; value: string; checked: boolean; onChoose: () => void; children: ReactNode }) {
  return (
    <label className="settings-choice">
      <input type="radio" name={props.name} value={props.value} checked={props.checked} onChange={props.onChoose} />
      <span>{props.children}</span>
    </label>
  );
}

function delayOf(text: string): number | null {
  if (!/^[0-9]{1,2}$/u.test(text)) return null;
  const seconds = Number(text);
  return seconds <= ATTENTION_DELAY_MAX_SECONDS ? seconds : null;
}

export interface AttentionSettingsProps {
  /** Default: the `Notification` of the browser, behind a dynamic import. */
  env?: NotificationPermissionEnv;
}

export function AttentionSettings({ env = browserPermissionEnv }: AttentionSettingsProps) {
  const t = useT();
  const { prefs, setPref } = usePrefs();
  const groupId = useId();
  // A task instance has no terminals: its scope is always every session, so there is nothing to choose.
  const task = useInstance().data?.kind === 'task';
  const current = attentionPrefsOf(prefs);
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  // What the person is typing into the delay field; `null` while the field shows the stored value.
  const [delayDraft, setDelayDraft] = useState<string | null>(null);

  // Reading the permission asks the browser nothing; only the button below does.
  useEffect(() => {
    let mounted = true;
    void env.read().then(
      (state) => {
        if (mounted) setPermission(state);
      },
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [env]);

  const blocked = permission === 'denied' || permission === 'unsupported';
  const delayId = `${groupId}-delay`;
  const delayHintId = `${groupId}-delay-hint`;

  return (
    <SettingsCard title={t('settings.attention.title')} note={t('settings.attention.note')}>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={current.attentionTitle}
          onChange={(event) => {
            setPref('attentionTitle', event.target.checked);
          }}
        />
        <span>
          {t('settings.attention.tabTitle')}
          <span className="settings-check__hint muted small">{t('settings.attention.tabTitle.hint')}</span>
        </span>
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={current.attentionFavicon}
          onChange={(event) => {
            setPref('attentionFavicon', event.target.checked);
          }}
        />
        <span>
          {t('settings.attention.favicon')}
          <span className="settings-check__hint muted small">{t('settings.attention.favicon.hint')}</span>
        </span>
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={current.attentionNotify && !blocked}
          disabled={blocked}
          onChange={(event) => {
            setPref('attentionNotify', event.target.checked);
          }}
        />
        <span>
          {t('settings.attention.notify')}
          <span className="settings-check__hint muted small">{t('settings.attention.notify.hint')}</span>
        </span>
      </label>
      {permission === null ? null : (
        <p className="muted small" data-permission={permission}>
          {t(PERMISSION_KEYS[permission])}
        </p>
      )}
      {permission === 'default' ? (
        <Button
          onClick={() => {
            void env.request().then(setPermission, () => undefined);
          }}
        >
          {t('settings.attention.permission.allow')}
        </Button>
      ) : null}
      {task ? null : (
        <fieldset className="settings-fieldset">
          <legend>{t('settings.attention.scope')}</legend>
          <div className="settings-choices">
            {SCOPES.map((option) => (
              <Choice
                key={option.value}
                name={`${groupId}-scope`}
                value={option.value}
                checked={current.attentionScope === option.value}
                onChoose={() => {
                  setPref('attentionScope', option.value);
                }}
              >
                {t(option.labelKey)}
              </Choice>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="settings-fieldset">
        <legend id={delayId}>{t('settings.attention.delay')}</legend>
        <input
          type="number"
          className="input"
          min={0}
          max={ATTENTION_DELAY_MAX_SECONDS}
          step={1}
          inputMode="numeric"
          aria-labelledby={delayId}
          aria-describedby={delayHintId}
          value={delayDraft ?? String(current.attentionDelaySeconds)}
          onChange={(event) => {
            setDelayDraft(event.target.value);
            const seconds = delayOf(event.target.value);
            if (seconds !== null) setPref('attentionDelaySeconds', seconds);
          }}
          onBlur={() => {
            setDelayDraft(null);
          }}
        />
        <p id={delayHintId} className="muted small">
          {t('settings.attention.delay.hint')}
        </p>
      </fieldset>
      <fieldset className="settings-fieldset">
        <legend>{t('settings.attention.titles')}</legend>
        <div className="settings-choices">
          {TITLES.map((option) => (
            <Choice
              key={option.value}
              name={`${groupId}-titles`}
              value={option.value}
              checked={current.workspaceTitles === option.value}
              onChoose={() => {
                setPref('workspaceTitles', option.value);
              }}
            >
              {t(option.labelKey)}
            </Choice>
          ))}
        </div>
        <p className="muted small">{t('settings.attention.titles.hint')}</p>
      </fieldset>
    </SettingsCard>
  );
}

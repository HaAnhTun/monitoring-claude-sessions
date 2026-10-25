import { PANEL_KEYS, type PanelKey, type PanelResponse } from '@mcs/shared';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';

import { useNow } from '../components/RelativeTime.tsx';
import type { IconName } from '../components/icons.ts';
import { describeApiError } from '../data/api-errors.ts';
import { useInstance } from '../data/hooks/useInstance.ts';
import { usePanel } from '../data/hooks/usePanel.ts';
import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { isPanelDisabled, toPanelViewStatus } from '../lib/panel-status.ts';
import { MQ_SHEET, useMediaQuery } from '../state/use-media-query.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { AttemptsPanel } from './AttemptsPanel.tsx';
import { ChainLogPanel } from './ChainLogPanel.tsx';
import { GitPanel } from './GitPanel.tsx';
import { LedgerPanel } from './LedgerPanel.tsx';
import { LogsPanel } from './LogsPanel.tsx';
import { MachinePanel } from './MachinePanel.tsx';
import { PanelFrame } from './PanelFrame.tsx';

interface PanelView {
  titleKey: Extract<MessageKey, `panels.${string}.title`>;
  icon: IconName;
}

/** The title and icon of each panel (the order of `PANEL_KEYS` is the order on the page: the legacy order). */
const VIEWS = {
  git: { titleKey: 'panels.git.title', icon: 'git-branch' },
  machine: { titleKey: 'panels.machine.title', icon: 'cpu' },
  attempts: { titleKey: 'panels.attempts.title', icon: 'layers' },
  ledger: { titleKey: 'panels.ledger.title', icon: 'tasks' },
  chainLog: { titleKey: 'panels.chainLog.title', icon: 'terminal' },
  logs: { titleKey: 'panels.logs.title', icon: 'file-text' },
} as const satisfies Record<PanelKey, PanelView>;

/** The key under which the collapsed state of a panel is stored in the preferences. */
export function collapsedKey(key: PanelKey): string {
  return `panel:${key}`;
}

/** The body of the panel that answered; nothing when no source produced data. */
const PanelBody = memo(function PanelBody({ response }: { response: PanelResponse }): ReactNode {
  switch (response.key) {
    case 'git':
      return response.data === null ? null : <GitPanel data={response.data} sources={response.sources} />;
    case 'machine':
      return response.data === null ? null : <MachinePanel data={response.data} sources={response.sources} />;
    case 'attempts':
      return response.data === null ? null : <AttemptsPanel data={response.data} sources={response.sources} />;
    case 'ledger':
      return response.data === null ? null : <LedgerPanel data={response.data} sources={response.sources} />;
    case 'chainLog':
      return response.data === null ? null : <ChainLogPanel data={response.data} sources={response.sources} />;
    case 'logs':
      return response.data === null ? null : <LogsPanel data={response.data} sources={response.sources} />;
  }
});

interface PanelHostProps {
  panelKey: PanelKey;
  /** `404 panel_disabled`: the configuration changed under the page. */
  onDisabled: (key: PanelKey) => void;
}

/**
 * One panel: reads the collapsed state (the stored choice, else collapsed below 900 px), fetches and polls its data only while it
 * is expanded, turns the query into the view status of the frame and draws the body. The data of the last good answer stays on
 * screen while a refresh fails.
 */
function PanelHost({ panelKey, onDisabled }: PanelHostProps) {
  const t = useT();
  const { prefs, setPref } = usePrefs();
  const narrow = useMediaQuery(MQ_SHEET);
  const instance = useInstance();
  const stored = prefs.collapsed?.[collapsedKey(panelKey)];
  const expanded = !(stored ?? narrow);
  const query = usePanel(panelKey, { expanded });
  const now = useNow(expanded && query.data !== undefined);
  const disabled = isPanelDisabled(query.error);

  useEffect(() => {
    if (disabled) onDisabled(panelKey);
  }, [disabled, onDisabled, panelKey]);

  const toggle = useCallback(
    (open: boolean) => {
      setPref('collapsed', { ...prefs.collapsed, [collapsedKey(panelKey)]: !open });
    },
    [prefs.collapsed, panelKey, setPref],
  );

  if (disabled) return null;

  const status = toPanelViewStatus(
    { data: query.data, error: query.error, isFetching: query.isFetching, dataUpdatedAt: query.dataUpdatedAt },
    now,
    instance.data?.staleAfterMs ?? Number.POSITIVE_INFINITY,
  );
  const errorDetail = query.error === null ? undefined : describeApiError(query.error, t);
  return (
    <PanelFrame
      panelKey={panelKey}
      title={t(VIEWS[panelKey].titleKey)}
      icon={VIEWS[panelKey].icon}
      status={status}
      expanded={expanded}
      onToggle={toggle}
      errorDetail={errorDetail}
    >
      {expanded && query.data !== undefined ? <PanelBody response={query.data} /> : null}
    </PanelFrame>
  );
}

/**
 * The workspace panels of the Overview (04-ui.md 4.4.1): Git, Machine, Attempts, Ledger, Chain log and Logs, in this order, each
 * only if the instance enables it. A panel the monitor answers with `404 panel_disabled` is removed until the instance is loaded
 * again, and its polling stops with it.
 */
export function WorkspacePanels() {
  const instance = useInstance();
  const stamp = instance.dataUpdatedAt;
  const [removed, setRemoved] = useState<{ stamp: number; keys: readonly PanelKey[] }>({ stamp, keys: [] });
  const gone = removed.stamp === stamp ? removed.keys : [];
  const onDisabled = useCallback(
    (key: PanelKey) => {
      setRemoved((previous) => {
        const keys = previous.stamp === stamp ? previous.keys : [];
        return keys.includes(key) ? previous : { stamp, keys: [...keys, key] };
      });
    },
    [stamp],
  );
  const enabled = instance.data?.panels;
  const keys = PANEL_KEYS.filter((key) => enabled?.[key] === true && !gone.includes(key));
  if (keys.length === 0) return null;
  return (
    <div className="workspace-panels" data-slot="workspace-panels">
      {keys.map((key) => (
        <PanelHost key={key} panelKey={key} onDisabled={onDisabled} />
      ))}
    </div>
  );
}

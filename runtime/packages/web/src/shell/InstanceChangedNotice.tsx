import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import { useInstance } from '../data/hooks/useInstance.ts';
import { qk } from '../data/query-keys.ts';
import { useT } from '../i18n/context.ts';
import { useAnnounce } from '../state/announcer.tsx';
import { usePrefsStore } from '../state/prefs-store.ts';

/**
 * UI-I11: data of two instances never mixes. Query keys already carry the instance id; this notice also drops the cache of the
 * id that was replaced (while the page is open, or the one remembered from the last visit in `lastInstanceId`) and says so.
 */
export function InstanceChangedNotice() {
  const id = useInstance().data?.instanceId;
  const client = useQueryClient();
  const prefs = usePrefsStore();
  const announce = useAnnounce();
  const t = useT();
  const seen = useRef<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (id === undefined) return;
    const previous = seen.current ?? prefs.getSnapshot().lastInstanceId ?? '';
    seen.current = id;
    if (previous !== '' && previous !== id) {
      client.removeQueries({ queryKey: qk.root(previous) });
      setChanged(true);
      setDismissed(false);
      announce(t('shell.instanceChanged.announce'), { force: true });
    }
    if (prefs.getSnapshot().lastInstanceId !== id) prefs.setPref('lastInstanceId', id);
  }, [id, client, prefs, announce, t]);

  if (!changed || dismissed) return null;
  return (
    <div className="notice" role="note">
      <Icon name="info" />
      <span>{t('shell.instanceChanged.body')}</span>
      <Button
        variant="quiet"
        onClick={() => {
          setDismissed(true);
        }}
      >
        {t('shell.instanceChanged.dismiss')}
      </Button>
    </div>
  );
}

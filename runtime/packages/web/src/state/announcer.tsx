// Polite screen reader announcements through one live region (04 section 6.6 rule 6). The timing rules (clear, set 30 ms
// later, dedupe within 500 ms) live in `lib/announce.ts`; this file connects them to React.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { createAnnouncer, type Announcer } from '../lib/announce.ts';

export type Announce = Announcer['announce'];

const NO_OP: Announce = () => false;

const AnnounceContext = createContext<Announce>(NO_OP);

/** `announce(message, { force })`; a no-op outside the provider, so components stay usable in isolation. */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

/** The one live region of the page: `role=status`, polite, atomic, visually hidden. */
export function LiveRegion({ text }: { text: string }) {
  return (
    <div id="live-region" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

/** Owns the live region and gives the tree `useAnnounce()`. */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const [announcer] = useState<Announcer>(() => createAnnouncer({ setText }));
  const [announce] = useState<Announce>(
    () => (message: string, options?: { force?: boolean }) => announcer.announce(message, options),
  );
  useEffect(
    () => () => {
      announcer.dispose();
    },
    [announcer],
  );
  return (
    <AnnounceContext value={announce}>
      {children}
      <LiveRegion text={text} />
    </AnnounceContext>
  );
}

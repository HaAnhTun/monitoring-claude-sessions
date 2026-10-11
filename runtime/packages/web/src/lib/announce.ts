// Polite screen reader announcements through one live region (04 section 6.6 rule 6). The region is cleared first and set
// 30 ms later so that an identical message is announced again (legacy behaviour); an identical message within 500 ms is
// dropped unless forced (React Strict Mode runs effects twice). The live region component supplies `setText`.

export const ANNOUNCE_DELAY_MS = 30;
export const ANNOUNCE_DEDUPE_MS = 500;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AnnouncerSink {
  /** Sets the text content of the live region. */
  setText(text: string): void;
  now?(): number;
}

export interface Announcer {
  /** Returns false when the message was empty or dropped as a duplicate. */
  announce(message: string, options?: { force?: boolean }): boolean;
  /** Cancels a pending update. */
  dispose(): void;
}

export function createAnnouncer(sink: AnnouncerSink): Announcer {
  let timer: TimerHandle | null = null;
  let lastMessage = '';
  let lastAt = Number.NEGATIVE_INFINITY;
  const now = (): number => sink.now?.() ?? Date.now();

  return {
    announce(message, options) {
      if (message === '') return false;
      const at = now();
      if (options?.force !== true && message === lastMessage && at - lastAt < ANNOUNCE_DEDUPE_MS) return false;
      lastMessage = message;
      lastAt = at;
      if (timer !== null) clearTimeout(timer);
      sink.setText('');
      timer = setTimeout(() => {
        timer = null;
        sink.setText(message);
      }, ANNOUNCE_DELAY_MS);
      return true;
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

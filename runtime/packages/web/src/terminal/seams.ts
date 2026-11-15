// The seams of the terminal view (design 04 7.2, D20): everything the connection hook and the view get from the outside world, as
// one context with real defaults. A test provides fakes through `renderWithProviders({ wrap })`: a fake engine (no xterm, which
// happy-dom cannot run), a socket over `FakeWebSocket` and a fake events client. The real xterm only runs in Playwright.
//
// - `loadEngine`: the lazy xterm chunk. The default imports `xterm-loader.ts` on demand, so neither the loader nor the three
//   packages join the chunk of any file that merely imports this module (the page provides no context: it uses the defaults).
// - `createSocket`: the one `WebSocket` of a session (`ws-client.ts`).
// - `createEventsClient`: the session list stream (`events-client.ts`); the page reads it through `useTerminalEvents`.
import { createContext, useContext } from 'react';

import { createEventsClient, type EventsClient, type EventsClientOptions } from './events-client.ts';
import type { TerminalEngine } from './engine.ts';
import { createTerminalSocket, type TerminalSocket, type TerminalSocketOptions } from './ws-client.ts';

export interface TerminalSeams {
  /** Resolves to the engine once the xterm chunk is loaded; rejects when a chunk cannot load (the view says so and offers Retry). */
  loadEngine: () => Promise<TerminalEngine>;
  createSocket: (options: TerminalSocketOptions) => TerminalSocket;
  createEventsClient: (options: EventsClientOptions) => EventsClient;
}

/** The real seams: a lazy import of the loader, the browser `WebSocket` and `EventSource`. */
export const DEFAULT_TERMINAL_SEAMS: TerminalSeams = {
  loadEngine: async () => {
    const loader = await import('./xterm-loader.ts');
    return loader.loadXtermEngine();
  },
  createSocket: createTerminalSocket,
  createEventsClient,
};

export const TerminalSeamsContext = createContext<TerminalSeams>(DEFAULT_TERMINAL_SEAMS);

/** The seams in force: the ones a test provided, else the real ones. */
export function useTerminalSeams(): TerminalSeams {
  return useContext(TerminalSeamsContext);
}

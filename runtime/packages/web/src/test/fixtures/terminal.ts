// FIXTURE: invented data for tests
// Typed factories for the access, terminal, folder and resume routes (ADR 0099). Every body validates against its route schema in
// `createFakeApi`; the names, paths and codes are invented and never real.
import type {
  Folder,
  FolderListResponse,
  ResumeEligibility,
  TerminalCapabilities,
  TerminalLink,
  TerminalSessionInfo,
  TerminalState,
} from '@mcs/shared';

import { FIXTURE_EPOCH, iso, sessionId } from './ids.ts';

/**
 * A well-formed access code (`ACCESS_CODE_RE`: 32 to 128 of letters, digits, underscore and dash). Invented: no server ever
 * minted it. `n` gives a different code.
 */
export function accessCode(n = 1): string {
  return `FIXTURE-access-code-${String(n).padStart(4, '0')}-0123456789abcdef`;
}

/** The `hash` of a location that carries the login fragment (`#code=<code>`). */
export function accessHash(code = accessCode()): string {
  return `#code=${code}`;
}

export function makeAuthSession(authenticated: boolean): { authenticated: boolean } {
  return { authenticated };
}

export function makeExchangeResponse(): { authenticated: true } {
  return { authenticated: true };
}

export function makeLogoutResponse(): { authenticated: false } {
  return { authenticated: false };
}

export function makeTerminalCapabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return { available: true, reason: null, folderPicker: true, resume: true, maxSessions: 8, ...overrides };
}

export function makeTerminalLink(overrides: Partial<TerminalLink> = {}): TerminalLink {
  return {
    status: 'pending',
    sessionId: null,
    previousSessionIds: [],
    basis: null,
    confidence: null,
    since: null,
    claudePid: null,
    transcript: 'none',
    registryStatus: null,
    waitingFor: null,
    reason: null,
    shared: false,
    ...overrides,
  };
}

/** `n` gives a distinct name, path and creation time. */
export function makeTerminalSession(n = 1, overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    name: `fixture-term-${String(n)}`,
    path: `/fixture/projects/app-${String(n)}`,
    createdAt: iso(-60 * n),
    cols: 120,
    rows: 30,
    viewers: 0,
    link: makeTerminalLink(),
    folderKey: `fixture-app-${String(n)}`,
    ...overrides,
  };
}

/** A session whose terminal is linked to the monitored session `sessionId(n)`. */
export function makeLinkedTerminalSession(n = 1, overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return makeTerminalSession(n, {
    link: makeTerminalLink({
      status: 'linked',
      sessionId: sessionId(n),
      transcript: 'tracked',
      registryStatus: 'idle',
    }),
    ...overrides,
  });
}

export function makeTerminalState(
  sessions: TerminalSessionInfo[] = [],
  overrides: Partial<TerminalState> = {},
): TerminalState {
  return {
    capabilities: makeTerminalCapabilities(),
    sessions,
    epoch: FIXTURE_EPOCH,
    generatedAt: iso(0),
    ...overrides,
  };
}

/** A terminal that cannot run on this system, with the reason the capabilities carry. */
export function makeUnavailableTerminalState(reason: NonNullable<TerminalCapabilities['reason']>): TerminalState {
  return makeTerminalState([], {
    capabilities: makeTerminalCapabilities({ available: false, reason, folderPicker: false, resume: false }),
  });
}

/** One row of `GET /folders`; `n` gives a distinct key, name and path. */
export function makeFolder(n = 1, overrides: Partial<Folder> = {}): Folder {
  return {
    key: `fixture-app-${String(n)}`,
    name: `fixture-app-${String(n)}`,
    path: `/fixture/projects/app-${String(n)}`,
    pathSource: 'da',
    exists: true,
    origins: ['da'],
    group: 'da',
    activity: 'none',
    lastActivityAt: null,
    da: null,
    claude: null,
    canStart: true,
    userAdded: false,
    ...overrides,
  };
}

export function makeFolderList(
  folders: Folder[] = [],
  overrides: Partial<FolderListResponse> = {},
): FolderListResponse {
  return {
    folders,
    sources: {
      daMemory: { status: 'ok', folders: folders.length, readAt: iso(0) },
      claudeHome: { status: 'ok', folders: 0, scannedAt: iso(0), truncated: false },
      userFolders: { status: 'ok', count: 0 },
    },
    asOf: iso(0),
    ...overrides,
  };
}

/** The eligibility of `sessionId(n)`: it may be resumed, and a copy too. */
export function makeResumeEligibility(n = 1, overrides: Partial<ResumeEligibility> = {}): ResumeEligibility {
  return {
    sessionId: sessionId(n),
    allowed: true,
    forkAllowed: true,
    reason: null,
    folder: { key: `fixture-app-${String(n)}`, path: `/fixture/projects/app-${String(n)}` },
    liveElsewhere: false,
    liveTerminal: null,
    redirectTo: null,
    ...overrides,
  };
}

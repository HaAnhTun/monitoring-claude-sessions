// @vitest-environment node
import type { Folder, SessionSummary, TerminalCapabilities, TerminalSessionInfo } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../data/api-errors.ts';
import { iso, makeSession, sessionId } from '../test/fixtures/index.ts';
import {
  buildWorkspaceView,
  folderModelOf,
  folderPrefKey,
  liveSessionOf,
  paneStateOf,
  recentRowsOf,
  rowStateOf,
  type AccessOutcomeShape,
  type EndedInfo,
  type FolderModel,
  type LiveSession,
  type PaneInput,
  type PaneState,
  type PaneTerminalState,
} from './workspace-view.ts';

const BS = String.fromCharCode(92);
/** `D:/work/alpha` written with the separator of Windows. */
const win = (path: string): string => path.replaceAll('/', BS);

function folder(key: string, over: Partial<FolderModel> = {}): FolderModel {
  return {
    key,
    name: key,
    path: win(`D:/work/${key}`),
    canStart: true,
    userAdded: false,
    activity: 'none',
    lastActivityAt: null,
    summary: null,
    counts: null,
    hasMemory: false,
    ...over,
  };
}

function live(name: string, over: Partial<LiveSession> = {}): LiveSession {
  return {
    name,
    path: win('D:/work/alpha'),
    folderKey: 'alpha',
    createdAt: iso(1),
    cols: 120,
    rows: 30,
    viewers: 1,
    link: {
      status: 'pending',
      sessionId: null,
      transcript: 'none',
      registryStatus: null,
      waitingFor: null,
      reason: null,
    },
    ...over,
  };
}

const linked = (id: number, over: Partial<LiveSession['link']> = {}): LiveSession['link'] => ({
  status: 'linked',
  sessionId: sessionId(id),
  transcript: 'tracked',
  registryStatus: null,
  waitingFor: null,
  reason: null,
  ...over,
});

const NO_MONITOR: ReadonlyMap<string, SessionSummary> = new Map<string, SessionSummary>();

function view(over: Partial<Parameters<typeof buildWorkspaceView>[0]> = {}): ReturnType<typeof buildWorkspaceView> {
  return buildWorkspaceView({
    folders: [],
    sessions: [],
    monitor: NO_MONITOR,
    filter: '',
    open: {},
    selected: '',
    ...over,
  });
}

describe('folderPrefKey', () => {
  it('is f_ and the low 52 bits of the 64-bit FNV-1a hash of the UTF-8 bytes, 13 hex digits', () => {
    expect(folderPrefKey('')).toBe('f_29ce484222325');
    expect(folderPrefKey('a')).toBe('f_3dc4c8601ec8c');
    expect(folderPrefKey('foobar')).toBe('f_44171f73967e8');
  });

  it('is short, stable and made of the characters a preference key allows', () => {
    const long = folderPrefKey('p'.repeat(255));
    expect(long).toMatch(/^f_[0-9a-f]{13}$/);
    expect(folderPrefKey('x-y-z')).toBe(folderPrefKey('x-y-z'));
    expect(folderPrefKey('x-y-z')).not.toBe(folderPrefKey('x-y-y'));
  });

  it('hashes the bytes of a non-ASCII key, not its UTF-16 units', () => {
    const accented = `caf${String.fromCharCode(0xe9)}`;
    expect(folderPrefKey(accented)).toMatch(/^f_[0-9a-f]{13}$/);
    expect(folderPrefKey(accented)).not.toBe(folderPrefKey('cafe'));
  });
});

describe('adapters from the wire shapes (Option A)', () => {
  const wireFolder = (over: Partial<Folder> = {}): Folder => ({
    key: 'alpha',
    name: 'alpha',
    path: win('D:/work/alpha'),
    pathSource: 'da',
    exists: true,
    origins: ['da'],
    group: 'da',
    activity: 'full',
    lastActivityAt: iso(5),
    da: { lastUpdatedAt: iso(5), activity: 'full', summary: 'Invented summary', brain: 3, action: 1 },
    claude: null,
    canStart: true,
    userAdded: false,
    ...over,
  });

  it('folderModelOf keeps the server mark and shows the counts only with a summary', () => {
    expect(folderModelOf(wireFolder())).toEqual({
      key: 'alpha',
      name: 'alpha',
      path: win('D:/work/alpha'),
      canStart: true,
      userAdded: false,
      activity: 'full',
      lastActivityAt: iso(5),
      summary: 'Invented summary',
      counts: { brain: 3, action: 1 },
      hasMemory: true,
    });
    const empty = folderModelOf(
      wireFolder({ da: { lastUpdatedAt: null, activity: 'none', summary: '', brain: 2, action: 2 } }),
    );
    expect(empty.summary).toBeNull();
    expect(empty.counts).toBeNull();
    expect(empty.hasMemory).toBe(true);
    const none = folderModelOf(wireFolder({ da: null, path: null, canStart: false, userAdded: true }));
    expect(none).toMatchObject({
      summary: null,
      counts: null,
      hasMemory: false,
      path: null,
      canStart: false,
      userAdded: true,
    });
  });

  it('liveSessionOf copies the row and the part of the link the rows need', () => {
    const info: TerminalSessionInfo = {
      name: 'alpha-1',
      path: win('D:/work/alpha'),
      createdAt: iso(2),
      cols: 100,
      rows: 40,
      viewers: 2,
      folderKey: 'alpha',
      link: {
        status: 'linked',
        sessionId: sessionId(3),
        previousSessionIds: [],
        basis: 'registry-pid',
        confidence: 'high',
        since: iso(2),
        claudePid: 1234,
        transcript: 'none',
        registryStatus: 'busy',
        waitingFor: null,
        reason: null,
        shared: false,
      },
    };
    expect(liveSessionOf(info)).toEqual({
      name: 'alpha-1',
      path: win('D:/work/alpha'),
      folderKey: 'alpha',
      createdAt: iso(2),
      cols: 100,
      rows: 40,
      viewers: 2,
      link: {
        status: 'linked',
        sessionId: sessionId(3),
        transcript: 'none',
        registryStatus: 'busy',
        waitingFor: null,
        reason: null,
      },
    });
  });
});

describe('rowStateOf (design 03 section 5.6)', () => {
  const monitor = new Map([[sessionId(1), makeSession({ id: sessionId(1) })]]);

  it('a pending link without a reason is starting', () => {
    expect(rowStateOf(live('a'), monitor)).toEqual({ kind: 'starting' });
  });

  it('a pending link the server gave a reason for (after its 30 s rule) is not linked', () => {
    for (const reason of ['no_registry', 'registry_unreadable'] as const) {
      const link = { ...live('a').link, reason };
      expect(rowStateOf(live('a', { link }), monitor), reason).toEqual({ kind: 'not-linked' });
    }
  });

  it('an ambiguous link is ambiguous, by status or by reason', () => {
    expect(rowStateOf(live('a', { link: { ...live('a').link, status: 'ambiguous' } }), monitor)).toEqual({
      kind: 'ambiguous',
    });
    expect(rowStateOf(live('a', { link: { ...live('a').link, reason: 'ambiguous' } }), monitor)).toEqual({
      kind: 'ambiguous',
    });
  });

  it('a linked process with no transcript yet reads its registry status as a lifecycle state', () => {
    const row = (registryStatus: 'busy' | 'idle' | 'waiting', waitingFor: string | null = null) =>
      rowStateOf(live('a', { link: linked(1, { transcript: 'none', registryStatus, waitingFor }) }), monitor);
    expect(row('busy')).toEqual({ kind: 'registry', state: 'working', waitingFor: null });
    expect(row('idle')).toEqual({ kind: 'registry', state: 'turn_ended', waitingFor: null });
    expect(row('waiting', 'permission')).toEqual({
      kind: 'registry',
      state: 'waiting_input',
      waitingFor: 'permission',
    });
  });

  it('a linked process with no transcript and no registry status is not linked', () => {
    expect(rowStateOf(live('a', { link: linked(1, { transcript: 'none' }) }), monitor)).toEqual({ kind: 'not-linked' });
  });

  it('a tracked transcript shows the monitor row, or not-linked while the row is not loaded yet', () => {
    const known = rowStateOf(live('a', { link: linked(1) }), monitor);
    expect(known).toEqual({ kind: 'monitor', summary: monitor.get(sessionId(1)) });
    expect(rowStateOf(live('a', { link: linked(2) }), monitor)).toEqual({ kind: 'not-linked' });
  });

  it('a linked link without a session id is not linked (defensive: the contract says it cannot happen)', () => {
    expect(rowStateOf(live('a', { link: linked(1, { sessionId: null }) }), monitor)).toEqual({ kind: 'not-linked' });
  });
});

describe('buildWorkspaceView', () => {
  describe('the join of a session to its folder', () => {
    it('goes by the folder key first', () => {
      const folders = [folder('alpha'), folder('beta')];
      const result = view({ folders, sessions: [live('s1', { folderKey: 'beta', path: win('D:/work/alpha') })] });
      const beta = result.rows.find((r) => r.folder.key === 'beta');
      expect(beta?.live.map((l) => l.session.name)).toEqual(['s1']);
      expect(result.rows.find((r) => r.folder.key === 'alpha')?.liveCount).toBe(0);
    });

    it('goes by the normalised path when there is no folder key: case, separators and a trailing separator do not matter', () => {
      const folders = [folder('alpha', { path: win('D:/Work/Alpha') })];
      for (const path of [win('d:/work/alpha'), 'D:/work/alpha', win('D:/WORK/alpha/'), 'd:/work/alpha//']) {
        const result = view({ folders, sessions: [live('s1', { folderKey: null, path })] });
        expect(result.rows, path).toHaveLength(1);
        expect(result.rows[0]?.folder.key, path).toBe('alpha');
        expect(result.rows[0]?.liveCount, path).toBe(1);
      }
    });

    it('goes by the path when the key names no known folder', () => {
      const result = view({ folders: [folder('alpha')], sessions: [live('s1', { folderKey: 'unknown-key' })] });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.folder.key).toBe('alpha');
    });

    it('never loses a session: an unknown folder becomes a synthetic one named after the last path segment', () => {
      const path = win('D:/elsewhere/gamma');
      const result = view({
        folders: [folder('alpha')],
        sessions: [live('s1', { folderKey: null, path }), live('s2', { folderKey: null, path: `${path}${BS}` })],
      });
      expect(result.liveTotal).toBe(2);
      const synthetic = result.rows.find((r) => r.folder.key !== 'alpha');
      expect(synthetic?.folder).toMatchObject({
        name: 'gamma',
        path,
        hasMemory: false,
        summary: null,
        counts: null,
        canStart: true,
        userAdded: false,
      });
      expect(synthetic?.live.map((l) => l.session.name)).toEqual(['s1', 's2']);
    });

    it('keeps the key of a folder the list does not know yet, so the row merges when the folder appears', () => {
      const sessions = [live('s1', { folderKey: 'late-folder', path: win('D:/work/late') })];
      const before = view({ folders: [], sessions });
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]?.folder.key).toBe('late-folder');
      const after = view({ folders: [folder('late-folder', { path: win('D:/work/late') })], sessions });
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.folder.hasMemory).toBe(false);
      expect(after.rows[0]?.liveCount).toBe(1);
    });

    it('a root path gives a name and an empty-looking path still does', () => {
      const result = view({ sessions: [live('s1', { folderKey: null, path: win('D:/') })] });
      expect(result.rows[0]?.folder.name).toBe('D:');
    });
  });

  describe('order', () => {
    const folders = [folder('a'), folder('b'), folder('c'), folder('d')];

    it('lists the folders with live sessions first, the rest in the server order', () => {
      const result = view({ folders, sessions: [live('s1', { folderKey: 'c' }), live('s2', { folderKey: 'b' })] });
      expect(result.rows.map((r) => r.folder.key)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('keeps the server order when nothing is live, and among the live folders', () => {
      expect(view({ folders }).rows.map((r) => r.folder.key)).toEqual(['a', 'b', 'c', 'd']);
      const result = view({ folders, sessions: [live('s1', { folderKey: 'd' }), live('s2', { folderKey: 'a' })] });
      expect(result.rows.map((r) => r.folder.key)).toEqual(['a', 'd', 'b', 'c']);
    });

    it('puts synthetic folders after the live folders of the server list, in the order of their first session', () => {
      const result = view({
        folders,
        sessions: [
          live('s1', { folderKey: null, path: win('D:/x/two') }),
          live('s2', { folderKey: 'c' }),
          live('s3', { folderKey: null, path: win('D:/x/one') }),
        ],
      });
      expect(result.rows.map((r) => r.folder.name)).toEqual(['c', 'two', 'one', 'a', 'b', 'd']);
    });

    it('keeps the order of the sessions inside a folder as given', () => {
      const result = view({
        folders,
        sessions: [live('s3', { folderKey: 'a' }), live('s1', { folderKey: 'a' }), live('s2', { folderKey: 'a' })],
      });
      expect(result.rows[0]?.live.map((l) => l.session.name)).toEqual(['s3', 's1', 's2']);
    });

    it('does not reorder when only the state of a session changes', () => {
      const sessions = [live('s1', { folderKey: 'b' }), live('s2', { folderKey: 'c' })];
      const first = view({ folders, sessions }).rows.map((r) => r.folder.key);
      const changed = view({
        folders,
        sessions: sessions.map((s) => ({ ...s, link: linked(1, { transcript: 'none', registryStatus: 'busy' }) })),
      }).rows.map((r) => r.folder.key);
      expect(changed).toEqual(first);
    });
  });

  describe('the rows of the live sessions', () => {
    it('marks the selected one and carries the row state of the rules above', () => {
      const monitor = new Map([[sessionId(1), makeSession({ id: sessionId(1) })]]);
      const result = view({
        folders: [folder('alpha')],
        monitor,
        selected: 's2',
        sessions: [live('s1'), live('s2', { link: linked(1) })],
      });
      const rows = result.rows[0]?.live ?? [];
      expect(rows.map((r) => [r.session.name, r.selected, r.row.kind])).toEqual([
        ['s1', false, 'starting'],
        ['s2', true, 'monitor'],
      ]);
    });

    it('counts every live session, also those of folders the filter hides', () => {
      const result = view({
        folders: [folder('alpha'), folder('beta')],
        sessions: [live('s1', { folderKey: 'alpha' }), live('s2', { folderKey: 'beta', path: win('D:/work/beta') })],
        filter: 'alpha',
      });
      expect(result.liveTotal).toBe(2);
      expect(result.rows.map((r) => r.folder.key)).toEqual(['alpha']);
    });
  });

  describe('the filter', () => {
    const folders = [
      folder('alpha', { name: 'Alpha Shop', path: win('D:/work/alpha') }),
      folder('beta', { name: 'Beta', path: win('E:/Clients/Gamma') }),
      folder('delta', { name: 'Delta', path: null }),
    ];

    it('shows everything for an empty filter or one of blanks, and hides nothing', () => {
      for (const filter of ['', '   ', '\t']) {
        const result = view({ folders, filter });
        expect(result.rows, JSON.stringify(filter)).toHaveLength(3);
        expect(result.hiddenByFilter).toBe(0);
      }
    });

    it('matches a case-insensitive substring of the name, of the path and of a live session name', () => {
      expect(view({ folders, filter: 'SHOP' }).rows.map((r) => r.folder.key)).toEqual(['alpha']);
      expect(view({ folders, filter: 'clients' + BS + 'gam' }).rows.map((r) => r.folder.key)).toEqual(['beta']);
      const sessions = [live('Build-7', { folderKey: 'delta', path: win('D:/work/delta') })];
      expect(view({ folders, sessions, filter: 'build-7' }).rows.map((r) => r.folder.key)).toEqual(['delta']);
    });

    it('reports how many folders it hides and shows a message-ready empty result', () => {
      const result = view({ folders, filter: 'zzz' });
      expect(result.rows).toEqual([]);
      expect(result.hiddenByFilter).toBe(3);
      expect(view({ folders, filter: 'alpha' }).hiddenByFilter).toBe(2);
    });

    it('a folder with a matching live session stays visible and keeps all its live sessions', () => {
      const sessions = [live('wanted', { folderKey: 'beta' }), live('other', { folderKey: 'beta' })];
      const result = view({ folders, sessions, filter: 'wanted' });
      expect(result.rows.map((r) => r.folder.key)).toEqual(['beta']);
      expect(result.rows[0]?.live.map((l) => l.session.name)).toEqual(['wanted', 'other']);
    });

    it('treats the characters of a pattern as plain text', () => {
      expect(view({ folders, filter: '.*' }).rows).toEqual([]);
      expect(view({ folders, filter: '(' }).rows).toEqual([]);
    });

    it('keeps a folder with a starting session visible when pinStartingFolders is set', () => {
      const sessions = [live('fresh', { folderKey: 'beta' })];
      expect(view({ folders, sessions, filter: 'alpha' }).rows.map((r) => r.folder.key)).toEqual(['alpha']);
      const pinned = view({ folders, sessions, filter: 'alpha', pinStartingFolders: true });
      expect(pinned.rows.map((r) => r.folder.key)).toEqual(['beta', 'alpha']);
      const settled = view({
        folders,
        sessions: [
          live('fresh', { folderKey: 'beta', link: linked(1, { transcript: 'none', registryStatus: 'idle' }) }),
        ],
        filter: 'alpha',
        pinStartingFolders: true,
      });
      expect(settled.rows.map((r) => r.folder.key)).toEqual(['alpha']);
    });
  });

  describe('open and closed', () => {
    const folders = [
      folder('quiet'),
      folder('busy-mark', { activity: 'full' }),
      folder('half-mark', { activity: 'half' }),
      folder('live-one'),
    ];
    const sessions = [live('s1', { folderKey: 'live-one' })];

    it('is open when it has live sessions or the full mark, closed otherwise (the default of MTOP)', () => {
      const open = Object.fromEntries(view({ folders, sessions }).rows.map((r) => [r.folder.key, r.open]));
      expect(open).toEqual({ quiet: false, 'busy-mark': true, 'half-mark': false, 'live-one': true });
    });

    it('lets the preference of the person win either way, by the hashed key', () => {
      const result = view({
        folders,
        sessions,
        open: {
          [folderPrefKey('quiet')]: true,
          [folderPrefKey('busy-mark')]: false,
          [folderPrefKey('live-one')]: false,
        },
      });
      const open = Object.fromEntries(result.rows.map((r) => [r.folder.key, r.open]));
      expect(open).toEqual({ quiet: true, 'busy-mark': false, 'half-mark': false, 'live-one': false });
    });

    it('ignores a preference under a raw key and one that names the prototype', () => {
      const result = view({ folders, sessions, open: { quiet: true, ['constructor']: true } });
      expect(result.rows.find((r) => r.folder.key === 'quiet')?.open).toBe(false);
    });
  });

  it('does not change its input', () => {
    const folders = [folder('a'), folder('b')];
    const sessions = [live('s1', { folderKey: 'b' })];
    const before = JSON.stringify({ folders, sessions });
    view({ folders, sessions, filter: 'b' });
    expect(JSON.stringify({ folders, sessions })).toBe(before);
  });
});

describe('recentRowsOf', () => {
  const summaries = [1, 2, 3, 4, 5, 6, 7].map((n) => makeSession({ id: sessionId(n) }));

  it('shows at most five rows and says when a sixth exists', () => {
    const six = recentRowsOf(summaries.slice(0, 6), []);
    expect(six.rows).toHaveLength(5);
    expect(six.more).toBe(true);
    const five = recentRowsOf(summaries.slice(0, 5), []);
    expect(five.rows).toHaveLength(5);
    expect(five.more).toBe(false);
  });

  it('hides the sessions that are open as terminals, before it counts', () => {
    const open = [live('s1', { link: linked(2) }), live('s2', { link: linked(4) })];
    const result = recentRowsOf(summaries.slice(0, 6), open);
    expect(result.rows.map((r) => r.summary.id)).toEqual([sessionId(1), sessionId(3), sessionId(5), sessionId(6)]);
    expect(result.more).toBe(false);
  });

  it('keeps the order it was given and is empty for nothing', () => {
    expect(recentRowsOf([], []).rows).toEqual([]);
    expect(recentRowsOf([], []).more).toBe(false);
    expect(recentRowsOf([summaries[2]!, summaries[0]!], []).rows.map((r) => r.summary.id)).toEqual([
      sessionId(3),
      sessionId(1),
    ]);
  });
});

describe('paneStateOf', () => {
  const capabilities: TerminalCapabilities = {
    available: true,
    reason: null,
    folderPicker: true,
    resume: true,
    maxSessions: 8,
  };
  const apiError = (): ApiError =>
    new ApiError('failed', { kind: 'http', status: 500, code: null, endpoint: 'health', requestId: null });
  const terminalData = (sessions: LiveSession[] = [], caps: Partial<typeof capabilities> = {}): PaneTerminalState => ({
    capabilities: { ...capabilities, ...caps },
    sessions,
  });

  const base = (over: Partial<PaneInput> = {}): PaneInput => ({
    auth: { data: { authenticated: true }, error: null },
    terminal: { data: terminalData([live('s1')]), error: null },
    monitor: NO_MONITOR,
    selected: 's1',
    endedLocal: null,
    focusRequested: false,
    accessOutcome: { kind: 'idle' },
    ...over,
  });

  const kind = (input: PaneInput): PaneState['kind'] => paneStateOf(input).kind;

  it('shows the terminal for a selected session that is in the list', () => {
    const state = paneStateOf(base({ focusRequested: true }));
    expect(state).toEqual({
      kind: 'terminal',
      session: live('s1'),
      row: { kind: 'starting' },
      focus: true,
      ended: null,
    });
  });

  it('gives the terminal the row state of its session', () => {
    const monitor = new Map([[sessionId(1), makeSession({ id: sessionId(1) })]]);
    const state = paneStateOf(
      base({ monitor, terminal: { data: terminalData([live('s1', { link: linked(1) })]), error: null } }),
    );
    expect(state.kind === 'terminal' && state.row.kind).toBe('monitor');
  });

  // Every adjacent pair of the priority order locked > unavailable > loading > error > terminal > not-found > none-selected:
  // an input that satisfies both gives the first, an input that satisfies only the second gives the second.
  describe('every adjacent pair of states', () => {
    const lockedInput = (over: Partial<PaneInput> = {}): PaneInput =>
      base({ auth: { data: { authenticated: false }, error: null }, ...over });
    const unavailableTerminal = {
      data: terminalData([], { available: false, reason: 'claude_not_found' }),
      error: null,
    };
    const noDataNoError = { data: undefined, error: null };
    const failedNoData = { data: undefined, error: apiError() };

    it('locked over unavailable', () => {
      expect(kind(lockedInput({ terminal: unavailableTerminal }))).toBe('locked');
      expect(kind(base({ terminal: unavailableTerminal }))).toBe('unavailable');
    });

    it('unavailable over loading', () => {
      // capabilities arrive with the data, so the two share no input: no data is loading, data that says unavailable is not
      expect(kind(base({ terminal: unavailableTerminal }))).toBe('unavailable');
      expect(kind(base({ terminal: noDataNoError }))).toBe('loading');
    });

    it('loading over error: a failed first load with no error object yet is loading, a settled failure is an error', () => {
      expect(kind(base({ terminal: noDataNoError }))).toBe('loading');
      expect(kind(base({ terminal: failedNoData }))).toBe('error');
    });

    it('error over terminal: an error with data is a refresh failure and the terminal stays', () => {
      expect(kind(base({ terminal: failedNoData }))).toBe('error');
      expect(kind(base({ terminal: { data: terminalData([live('s1')]), error: apiError() } }))).toBe('terminal');
    });

    it('terminal over not-found: an ended session that left the list keeps the view', () => {
      const ended: EndedInfo = { name: 's9', session: live('s9'), exitCode: 0, killed: false };
      const absent = base({ selected: 's9', terminal: { data: terminalData([live('s1')]), error: null } });
      expect(kind(absent)).toBe('not-found');
      expect(kind({ ...absent, endedLocal: ended })).toBe('terminal');
    });

    it('not-found over none-selected', () => {
      expect(kind(base({ selected: 'gone' }))).toBe('not-found');
      expect(kind(base({ selected: '' }))).toBe('none-selected');
    });

    it('also holds for the non-adjacent pairs that share an input', () => {
      expect(kind(lockedInput({ terminal: noDataNoError }))).toBe('locked');
      expect(kind(lockedInput({ terminal: failedNoData }))).toBe('locked');
      expect(kind(lockedInput({ selected: '' }))).toBe('locked');
      expect(kind(base({ terminal: unavailableTerminal, selected: '' }))).toBe('unavailable');
    });
  });

  describe('locked', () => {
    it('is the state of an unauthenticated browser, whatever else is known', () => {
      const state = paneStateOf(base({ auth: { data: { authenticated: false }, error: null } }));
      expect(state).toEqual({ kind: 'locked', outcome: { kind: 'idle' } });
    });

    it('is also the state of every access outcome other than idle and granted, carrying the outcome', () => {
      const outcomes: AccessOutcomeShape[] = [
        { kind: 'exchanging' },
        { kind: 'cookie-not-kept' },
        { kind: 'invalid' },
        { kind: 'rate-limited' },
        { kind: 'failed' },
      ];
      for (const accessOutcome of outcomes) {
        expect(paneStateOf(base({ accessOutcome })), accessOutcome.kind).toEqual({
          kind: 'locked',
          outcome: accessOutcome,
        });
      }
      for (const accessOutcome of [{ kind: 'idle' }, { kind: 'granted' }] as const) {
        expect(kind(base({ accessOutcome })), accessOutcome.kind).toBe('terminal');
      }
    });

    it('keeps the extra fields of the richer outcome of the access flow', () => {
      const rate = { kind: 'rate-limited', retryAfterMs: 4000 } as const;
      const state = paneStateOf(base({ auth: { data: { authenticated: false }, error: null }, accessOutcome: rate }));
      expect(state).toEqual({ kind: 'locked', outcome: rate });
    });
  });

  describe('loading and error', () => {
    it('is loading while the authentication is not known and nothing failed', () => {
      expect(kind(base({ auth: { data: undefined, error: null }, terminal: { data: undefined, error: null } }))).toBe(
        'loading',
      );
    });

    it('reports the error of the terminal data, or of the authentication when the data cannot load without it', () => {
      const terminalError = apiError();
      const state = paneStateOf(base({ terminal: { data: undefined, error: terminalError } }));
      expect(state).toEqual({ kind: 'error', error: terminalError });
      const authError = apiError();
      const noAuth = paneStateOf(
        base({ auth: { data: undefined, error: authError }, terminal: { data: undefined, error: null } }),
      );
      expect(noAuth).toEqual({ kind: 'error', error: authError });
    });
  });

  describe('unavailable', () => {
    it('names the three reasons the page has a notice for', () => {
      for (const reason of ['unsupported_os', 'addon_missing', 'claude_not_found'] as const) {
        const terminal = { data: terminalData([], { available: false, reason }), error: null };
        expect(paneStateOf(base({ terminal })), reason).toEqual({ kind: 'unavailable', reason });
      }
    });

    it('reads a reason the page never meets (not_configured, or none) as the missing component', () => {
      for (const reason of ['not_configured', null] as const) {
        const terminal = { data: terminalData([], { available: false, reason }), error: null };
        expect(paneStateOf(base({ terminal })), String(reason)).toEqual({
          kind: 'unavailable',
          reason: 'addon_missing',
        });
      }
    });
  });

  describe('the ended banner', () => {
    const ended: EndedInfo = { name: 's1', session: live('s1', { cols: 80 }), exitCode: 3, killed: false };

    it('is attached to the terminal state when the selected session is the one that ended and it is still listed', () => {
      const state = paneStateOf(base({ endedLocal: ended }));
      expect(state).toMatchObject({ kind: 'terminal', ended });
    });

    it('shows the snapshot of the ended session once it left the list', () => {
      const state = paneStateOf(
        base({ selected: 's1', endedLocal: ended, terminal: { data: terminalData([]), error: null } }),
      );
      expect(state).toMatchObject({ kind: 'terminal', session: ended.session, ended });
    });

    it('is ignored when it belongs to another session than the selected one', () => {
      const state = paneStateOf(base({ selected: 's2', endedLocal: ended }));
      expect(state.kind).toBe('not-found');
    });
  });

  describe('not-found and none-selected', () => {
    it('names the session that is not running', () => {
      expect(paneStateOf(base({ selected: 'gone' }))).toEqual({ kind: 'not-found', name: 'gone' });
    });

    it('is none-selected for no selection, even with sessions running', () => {
      expect(paneStateOf(base({ selected: '' }))).toEqual({ kind: 'none-selected' });
    });
  });

  it('never throws and always answers one state, over every combination of the inputs', () => {
    const kinds = new Set<string>();
    const auths = [
      { data: undefined, error: null },
      { data: { authenticated: false }, error: null },
      { data: { authenticated: true }, error: null },
      { data: undefined, error: apiError() },
    ];
    const terminals = [
      { data: undefined, error: null },
      { data: undefined, error: apiError() },
      { data: terminalData([live('s1')]), error: null },
      { data: terminalData([], { available: false, reason: 'unsupported_os' }), error: null },
    ];
    for (const auth of auths) {
      for (const terminal of terminals) {
        for (const selected of ['', 's1', 'zz']) {
          for (const accessOutcome of [{ kind: 'idle' }, { kind: 'invalid' }] as const) {
            kinds.add(kind(base({ auth, terminal, selected, accessOutcome })));
          }
        }
      }
    }
    expect([...kinds].sort()).toEqual(
      ['error', 'loading', 'locked', 'none-selected', 'not-found', 'terminal', 'unavailable'].sort(),
    );
  });
});

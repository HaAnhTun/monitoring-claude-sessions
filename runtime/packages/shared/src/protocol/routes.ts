/**
 * Routing of hook events to instances and the per-user `MCS_HOME` folder (02 2.6; ADR 0011).
 *
 * Zod-free so the handler and the engine share it (98 1.7, N8). The zod mirror of `HookRouteV1` is
 * `HookRouteV1Schema` in `schemas/ingest.ts`.
 */
import { hostIsWin32, normalizePath, routeKey } from './sanitize.ts';

/** `$MCS_HOME/routes/<instanceId>.json`, written by the server and the CLI, read by the handler (02 2.6.2). */
export interface HookRouteV1 {
  v: 1;
  /** uuid v4, equals `instance.json` `instanceId`; the file name is `<instanceId>.json`. */
  instanceId: string;
  /** `normalizePath(absolute task workspace)`. */
  workspace: string;
  /** MUST equal `workspace + '/data/spool'` (the handler rejects anything else). */
  spoolDir: string;
  /** MUST equal `workspace + '/state.json'`. */
  stateFile: string;
  /** `instance.json` `hooks.enabled`. */
  enabled: boolean;
  match: {
    /** `routeKey()` of the resolved `transcripts_dir` and of the predicted one; at most 8. */
    transcriptsDirs: string[];
    /** Legacy pinned `session_id`s; at most 256. */
    sessionIds: string[];
  };
  /** `null` while the server runs. */
  stoppedAt: number | null;
  /** A stopped instance keeps receiving envelopes until this time (`null` = never). */
  spoolUntil: number | null;
  updatedAt: number;
}

/** The ids `matchRoutes` reads from a hook payload (already validated by the handler, 02 2.3.2). */
export interface RouteMatchIds {
  session_id: string | null;
  transcript_path: string | null;
  cwd: string | null;
}

/** Why a route matched; the handler turns `session_pin` and `cwd` into the envelope flags `routed_by_*`. */
export type RouteMatchVia = 'transcript' | 'session_pin' | 'cwd';

export interface RouteMatchOptions {
  /** Override the host platform (tests, a CLI that evaluates routes written on another platform). */
  readonly win32?: boolean;
}

/**
 * Project folder name Claude Code derives from a launch directory: every character outside `[A-Za-z0-9]` becomes `-`
 * (TS:1, `docs/research/transcript-survey.md`). Counted per UTF-16 unit, as the JavaScript original does.
 */
export function sanitizeProjectName(directory: string): string {
  return directory.replace(/[^A-Za-z0-9]/g, '-');
}

/** Directory part of an already normalized path; '' when there is none, the root keeps its slash. */
function dirnameOf(normalized: string): string {
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 0) return '/';
  const dir = normalized.slice(0, slash);
  return /^[A-Za-z]:$/.test(dir) ? dir + '/' : dir;
}

function lastSegment(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Why `route` takes this event, or `null` when it does not (02 2.6.2). All of these must hold: version 1, enabled,
 * `spoolDir` and `stateFile` inside the workspace, running or inside its spool window (`now < spoolUntil`), and one
 * of: the folder of `transcript_path` is a known transcripts folder; the session id is pinned; or, without a
 * `transcript_path`, the sanitized `cwd` names a known transcripts folder (case-insensitive).
 */
export function matchRoute(
  route: HookRouteV1,
  ids: RouteMatchIds,
  now: number,
  options: RouteMatchOptions = {},
): RouteMatchVia | null {
  // Route files come from disk: check the two fields at run time even though the type promises them.
  const untrusted: { readonly v: unknown; readonly enabled: unknown } = route;
  if (untrusted.v !== 1 || untrusted.enabled !== true) return null;
  if (route.spoolDir !== route.workspace + '/data/spool' || route.stateFile !== route.workspace + '/state.json') {
    return null;
  }
  if (route.stoppedAt !== null && !(route.spoolUntil !== null && now < route.spoolUntil)) return null;

  const win32 = options.win32 ?? hostIsWin32();
  if (ids.transcript_path !== null) {
    const folder = routeKey(dirnameOf(normalizePath(ids.transcript_path)), win32);
    if (route.match.transcriptsDirs.includes(folder)) return 'transcript';
  }
  if (ids.session_id !== null && route.match.sessionIds.includes(ids.session_id)) return 'session_pin';
  if (ids.transcript_path === null && ids.cwd !== null && ids.cwd !== '') {
    const project = sanitizeProjectName(normalizePath(ids.cwd)).toLowerCase();
    if (project !== '' && route.match.transcriptsDirs.some((dir) => lastSegment(dir).toLowerCase() === project)) {
      return 'cwd';
    }
  }
  return null;
}

/** The routes that take an event, in input order (pure; 02 2.6.2). */
export function matchRoutes(
  routes: readonly HookRouteV1[],
  ids: RouteMatchIds,
  now: number,
  options: RouteMatchOptions = {},
): HookRouteV1[] {
  return routes.filter((route) => matchRoute(route, ids, now, options) !== null);
}

// ---- MCS_HOME ----------------------------------------------------------------------------------------------------

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface ResolveMcsHomeOptions {
  /** Override the host platform. */
  readonly win32?: boolean;
  /** Home directory for the fallbacks; defaults to `USERPROFILE` (Windows) or `HOME`. */
  readonly homedir?: string;
}

function isAbsolutePath(path: string, win32: boolean): boolean {
  if (win32) return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
  return path.startsWith('/');
}

function stripTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  const stripped = path.slice(0, end);
  return /^[A-Za-z]:$/.test(stripped) ? stripped + path.slice(end, end + 1) : stripped;
}

/**
 * The per-user monitor folder (02 2.6.1): `MCS_HOME` if it is absolute; else on Windows `%LOCALAPPDATA%/mcs`
 * (fallback `<home>/AppData/Local/mcs`); else `${XDG_STATE_HOME:-<home>/.local/state}/mcs`. A relative value of any of
 * the variables is ignored (the handler must never write below its working directory). Throws when no home can be
 * found.
 */
export function resolveMcsHome(env: EnvLike, options: ResolveMcsHomeOptions = {}): string {
  const win32 = options.win32 ?? hostIsWin32();
  const explicit = env['MCS_HOME'];
  if (explicit !== undefined && explicit !== '' && isAbsolutePath(explicit, win32)) {
    return stripTrailingSeparators(explicit);
  }
  const home = (): string => {
    const found = options.homedir ?? (win32 ? (env['USERPROFILE'] ?? env['HOME']) : env['HOME']);
    if (found === undefined || found === '') throw new Error('resolveMcsHome: no home directory (set MCS_HOME)');
    return stripTrailingSeparators(found);
  };
  if (win32) {
    const local = env['LOCALAPPDATA'];
    if (local !== undefined && local !== '' && isAbsolutePath(local, true))
      return stripTrailingSeparators(local) + '/mcs';
    return home() + '/AppData/Local/mcs';
  }
  const state = env['XDG_STATE_HOME'];
  if (state !== undefined && state !== '' && isAbsolutePath(state, false))
    return stripTrailingSeparators(state) + '/mcs';
  return home() + '/.local/state/mcs';
}

// Folder path helpers of the projects area (CAW design 03 section 3, amendment A2). Isomorphic: no `node:` import and no
// `process.platform`, so the web, the CLI and the engine share one definition and one test table. The Windows form of a
// folder is MTOP's `normalize_path`; the checks added here keep a path that could reach another machine (UNC), another
// namespace (device paths, alternate data streams, reserved names) or a spoofed display (format characters) out of a
// process that starts in it.

/** The reasons `folderPathIssue` names; the first one found, in this order, is the answer (and the `details.issue` of `folder_invalid`). */
export const FOLDER_PATH_ISSUES = [
  'relative',
  'unc',
  'device',
  'stream',
  'reserved_name',
  'format_char',
  'control',
  'too_long',
] as const;
export type FolderPathIssue = (typeof FOLDER_PATH_ISSUES)[number];

/** The longest normalized path accepted (UTF-16 code units; the classic Windows limit is 260 with room for a file name). */
export const MAX_FOLDER_PATH_CHARS = 240;

const DEVICE_PREFIX = /^(?:[\\/]{2}[?.](?:[\\/]|$)|[\\/]\?\?(?:[\\/]|$))/;
const UNC_PREFIX = /^[\\/]{2}/;
const WSL_DRIVE_PATH = /^\/mnt\/([a-z])(?:\/(.*))?$/s;
const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/s;
const SEPARATORS = /[\\/]+/;
/** Windows device names: they open a device, never a folder, with or without an extension (the superscript digits count too). */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
const FORMAT_CHAR = /\p{Cf}/u;

type Analysis =
  { readonly path: string; readonly issue: null } | { readonly path: null; readonly issue: FolderPathIssue };

const refused = (issue: FolderPathIssue): Analysis => ({ path: null, issue });

/** Trims the text and removes the quotes a person pastes around a path (MTOP `strip().strip('"')`). */
function unquote(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, '');
}

function segmentsOf(rest: string): string[] {
  return rest.split(SEPARATORS).filter((segment) => segment !== '');
}

/** C0 controls, DEL and C1 controls (a character class literal for them would trip `no-control-regex`). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isReservedSegment(segment: string): boolean {
  const dot = segment.indexOf('.');
  const base = (dot < 0 ? segment : segment.slice(0, dot)).replace(/ +$/, '');
  return RESERVED_NAME.test(base);
}

function analyze(raw: string, win32: boolean): Analysis {
  const text = unquote(raw);
  if (DEVICE_PREFIX.test(text)) return refused('device');
  if (UNC_PREFIX.test(text)) return refused('unc');
  const wsl = WSL_DRIVE_PATH.exec(text);
  const drive = wsl === null ? DRIVE_PATH.exec(text) : null;
  let normalized: string;
  if (wsl !== null || drive !== null) {
    const letter = (wsl?.[1] ?? drive?.[1] ?? '').toUpperCase();
    const segments = segmentsOf(wsl?.[2] ?? drive?.[2] ?? '');
    if (segments.some((segment) => segment.includes(':'))) return refused('stream');
    if (segments.some(isReservedSegment)) return refused('reserved_name');
    normalized = `${letter}:\\${segments.join('\\')}`;
  } else if (!win32 && text.startsWith('/')) {
    normalized = `/${segmentsOf(text).join('/')}`;
  } else {
    // empty, relative, rooted without a drive (`\x`), drive-relative (`D:`, `D:x`) and, on Windows, a POSIX path
    return refused('relative');
  }
  if (FORMAT_CHAR.test(text)) return refused('format_char');
  if (hasControlChar(text)) return refused('control');
  if (normalized.length > MAX_FOLDER_PATH_CHARS) return refused('too_long');
  return { path: normalized, issue: null };
}

/**
 * The Windows form of a folder (MTOP `normalize_path`): `D:\a\b\`, `d:/a/b` and `"D:\x y"` become `D:\a\b` and `D:\x y`;
 * the WSL spelling `/mnt/d/a/b` becomes `D:\a\b`. Another absolute POSIX path is kept (without a trailing separator) when
 * `win32` is false and refused on Windows, where it has no drive to live on. `null` for everything `folderPathIssue` names:
 * relative, UNC and device paths, a `:` after the drive, a reserved device name, a Unicode format character (category Cf), a
 * control character and more than 240 characters.
 */
export function windowsFolderPath(raw: string, win32 = true): string | null {
  return analyze(raw, win32).path;
}

/** The first reason `windowsFolderPath` refuses the path, or `null` when it accepts it. */
export function folderPathIssue(raw: string, win32 = true): FolderPathIssue | null {
  return analyze(raw, win32).issue;
}

/**
 * MTOP `path_key`: the normalized path without a trailing separator, in lower case, so that every spelling of one folder
 * gives one key. A path that cannot be a folder is folded the same way (separators, trailing separator, case) so that two
 * spellings of it still compare equal; the empty path gives the empty key.
 */
export function folderPathKey(path: string): string {
  const normalized = windowsFolderPath(path) ?? unquote(path).replaceAll('/', '\\');
  return normalized.replace(/\\+$/, '').toLowerCase();
}

/** The last non-empty segment of a path (`D:` for a drive root), `''` when there is none. */
export function lastSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

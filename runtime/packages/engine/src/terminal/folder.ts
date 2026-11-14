// The working folder of a session (design 01 section 3.6 and amendment A3): MTOP `normalize_path` and `path_key`, with the
// refusals of the shared `windowsFolderPath`. Pure: the platform is an argument and nothing here touches the file system.
import path from 'node:path';

import { isCaseInsensitive, type HostPlatform } from '../platform/host.ts';
import { stripExtendedPrefix } from '../platform/paths.ts';
import { FOLDER_INPUT_MAX_CHARS, FOLDER_MAX_CHARS, FOLDER_MAX_CHARS_POSIX } from './limits.ts';

/** The one question the service asks the file system about a folder. */
export interface FolderFs {
  isDirectory(path: string): boolean;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
/** `/mnt/<letter>` and what follows, the spelling of a Windows drive in WSL. */
const WSL_DRIVE_PATH = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u;
const DRIVE_PREFIX = /^[A-Za-z]:(?:\\|$)/u;
/** CON, PRN, AUX, NUL, COM1-9 and LPT1-9 (also with the superscript digits), CONIN$ and CONOUT$: names Windows reserves. */
const RESERVED_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)$/iu;
const DOUBLE_QUOTE = 0x22;

/** Removes every double quote at both ends (Python `strip('"')`), without a regular expression over the text. */
function stripSurroundingQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === DOUBLE_QUOTE) start += 1;
  while (end > start && text.charCodeAt(end - 1) === DOUBLE_QUOTE) end -= 1;
  return text.slice(start, end);
}

/** Windows reserves a device name with or without an extension, and ignores trailing spaces: `NUL.txt`, `CON `. */
function isReservedDeviceName(segment: string): boolean {
  const dot = segment.indexOf('.');
  const base = (dot === -1 ? segment : segment.slice(0, dot)).trimEnd();
  return RESERVED_DEVICE_NAME.test(base);
}

function normalizeWindows(text: string): string | null {
  if (FORMAT_CHARACTER.test(text)) return null;
  let spelled = text;
  const wsl = WSL_DRIVE_PATH.exec(spelled);
  if (wsl !== null) spelled = `${(wsl[1] ?? '').toUpperCase()}:\\${wsl[2] ?? ''}`;
  spelled = stripExtendedPrefix(spelled.replaceAll('/', '\\'));
  // A drive and nothing else: relative paths, a rooted path without a drive, `D:x` (relative to a drive's own folder), and
  // UNC and device paths (`\\server\share`, `\\.\COM1`) all fail here. cmd.exe cannot use a UNC path as its current directory.
  if (!DRIVE_PREFIX.test(spelled)) return null;
  const drive = spelled.charAt(0).toUpperCase();
  const rest = spelled.slice(2);
  // A ":" after the drive is an NTFS stream spelling (`D:\x:evil`, `D:\x::$INDEX_ALLOCATION`).
  if (rest.includes(':')) return null;
  // The raw segments are checked, so `D:\NUL\..\x` is refused although it collapses to a harmless path.
  if (rest.split('\\').some(isReservedDeviceName)) return null;
  const normalized = path.win32.normalize(`${drive}:${rest === '' ? '\\' : rest}`);
  const folder = normalized.length > 3 ? normalized.replace(/\\+$/u, '') : normalized;
  return folder.length > FOLDER_MAX_CHARS ? null : folder;
}

function normalizePosix(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const normalized = path.posix.normalize(text);
  const folder = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  return folder.length > FOLDER_MAX_CHARS_POSIX ? null : folder;
}

/**
 * The spelling of a working folder that the service uses (`D:\x`), or `null` when it cannot be one (the service maps that to
 * FOLDER_INVALID). On Windows: surrounding quotes and spaces are removed, `/mnt/d/x` and `D:/x` become `D:\x`, the drive letter
 * is upper case, no trailing separator except the root, `..` and `.` are collapsed. Refused: empty, a control character, a
 * relative path (MTOP used the server folder; never here), UNC and device paths, a ":" after the drive, a reserved device
 * name, a Unicode format character (bidi marks, zero width), more than 240 characters. A POSIX host takes absolute paths only.
 * The path is not resolved through links: the UI groups by the spelling, and `folderKey` only compares.
 */
export function normalizeFolder(raw: string, platform: HostPlatform): string | null {
  if (raw.length > FOLDER_INPUT_MAX_CHARS) return null;
  const text = stripSurroundingQuotes(raw.trim()).trim();
  if (text === '' || CONTROL_CHARACTER.test(text)) return null;
  return platform === 'win32' ? normalizeWindows(text) : normalizePosix(text);
}

function stripTrailingSeparators(text: string, separators: string): string {
  let end = text.length;
  while (end > 0 && separators.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * The key that groups sessions by project (MTOP `path_key`): the normalized folder without a trailing separator, case-folded
 * where the file system ignores case. The root of a drive is `d:`, the root of a POSIX host stays `/`. A text that is no
 * folder still gets a key (trimmed, lower-cased) and never throws.
 */
export function folderKey(folder: string, platform: HostPlatform): string {
  const base = normalizeFolder(folder, platform) ?? folder.trim();
  const trimmed = stripTrailingSeparators(base, platform === 'win32' ? '\\/' : '/');
  const key = trimmed === '' && base.startsWith('/') && platform !== 'win32' ? '/' : trimmed;
  return isCaseInsensitive(platform) ? key.toLowerCase() : key;
}

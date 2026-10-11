// The one place that reads `process.platform` for the rest of the engine (06 section 4, platform branching rule, I-34).
// Other engine modules import `hostPlatform` or `pathsCaseInsensitive` from here; lint forbids `process.platform` elsewhere
// in packages/engine/src outside platform/** and security/paths.ts.

export type HostPlatform = 'win32' | 'linux' | 'darwin' | 'other';

/** Maps a Node `process.platform` string to the four values the engine distinguishes. */
export function classifyPlatform(platform: string): HostPlatform {
  switch (platform) {
    case 'win32':
    case 'linux':
    case 'darwin':
      return platform;
    default:
      return 'other';
  }
}

/** File systems of Windows and macOS compare names case-insensitively by default; Linux does not. */
export function isCaseInsensitive(platform: HostPlatform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** The platform of this process, evaluated once. */
export const hostPlatform: HostPlatform = classifyPlatform(process.platform);

/** True when path comparison must ignore case on this host. */
export const pathsCaseInsensitive: boolean = isCaseInsensitive(hostPlatform);

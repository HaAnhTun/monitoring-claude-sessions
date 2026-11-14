// Session names (design 01 section 3.7): `<folder name>-<n>`, always matching SESSION_NAME_RE.
import { TerminalError } from './errors.ts';
import { SESSION_BASE_MAX, SESSION_NAME_MAX } from './limits.ts';

const NAME_BASE_RE = new RegExp(`^[A-Za-z0-9_-]{1,${String(SESSION_BASE_MAX)}}$`);
const OUTSIDE_NAME_CHARS = /[^A-Za-z0-9_-]/gu;

/**
 * The folder name in the alphabet of a session name (MTOP `session_base`): the last path segment, every code point outside
 * `[A-Za-z0-9_-]` replaced by `_`, at most 60 characters, `session` when nothing is left.
 */
export function sessionBase(folder: string): string {
  const segments = folder.split(/[\\/]+/u).filter((segment) => segment !== '');
  const last = segments[segments.length - 1] ?? '';
  const base = last.replace(OUTSIDE_NAME_CHARS, '_').slice(0, SESSION_BASE_MAX);
  return base === '' ? 'session' : base;
}

/**
 * Hands out `<base>-<n>`. The number counts up per base for the life of the allocator and a name is never issued twice (MTOP
 * reused the lowest free number): a stale browser tab that holds `proj-1` can never reach a different `proj-1`.
 */
export class NameAllocator {
  readonly #counters = new Map<string, number>();
  readonly #issued = new Set<string>();

  /** Throws NAME_INVALID when `base` is not 1 to 60 characters of `[A-Za-z0-9_-]` (use `sessionBase` to make one). */
  next(base: string): string {
    if (!NAME_BASE_RE.test(base)) throw new TerminalError('NAME_INVALID');
    let n = this.#counters.get(base) ?? 0;
    for (;;) {
      n += 1;
      const suffix = `-${String(n)}`;
      // The base gives way, never the number: the whole name stays within 64 characters for n >= 1000 too.
      const name = base.slice(0, SESSION_NAME_MAX - suffix.length) + suffix;
      // Two bases that differ only in the characters cut away would meet at the same name: skip a name that was used.
      if (!this.#issued.has(name)) {
        this.#issued.add(name);
        this.#counters.set(base, n);
        return name;
      }
    }
  }
}

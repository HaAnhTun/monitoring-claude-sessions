// Seeded generator for the property tests of the lifecycle model (02 7.12): mulberry32, no dependency. Every property
// prints its seed on failure, so a failing case is replayed with MCS_TEST_SEED=<seed>.

/** The public-domain mulberry32 algorithm: a function returning the next float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A seed from `MCS_TEST_SEED` when it holds a non-negative integer, else the fallback. */
export function seedFromEnv(env: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = env['MCS_TEST_SEED'];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return fallback;
  return Number(raw);
}

export class Prng {
  readonly seed: number;
  readonly #next: () => number;

  constructor(seed: number) {
    this.seed = seed;
    this.#next = mulberry32(seed);
  }

  /** Next float in [0, 1). */
  next(): number {
    return this.#next();
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`int() needs a positive integer bound, got ${String(maxExclusive)}`);
    }
    return Math.floor(this.#next() * maxExclusive);
  }

  /** Integer in [lo, hi] (both included). */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(probability: number): boolean {
    return this.#next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() of an empty list');
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RangeError('pick() hit a hole');
    return item;
  }

  /** A shuffled copy (Fisher-Yates); the input is not touched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) throw new RangeError('shuffle() hit a hole');
      out[i] = b;
      out[j] = a;
    }
    return out;
  }
}

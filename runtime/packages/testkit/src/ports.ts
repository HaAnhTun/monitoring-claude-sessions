// Port allocation (05 4.5, registry C32): the only free-port helper of the testkit.
import { connect, createServer } from 'node:net';

export type PortRange = readonly [min: number, max: number];

/** Real-process Vitest tests: blocks of 50 per worker inside this range. */
export const VITEST_PORTS: PortRange = [18000, 18499];

const BLOCK_SIZE = 50;

/** Never touched by any test: the live monitor scan, the blog dev servers and the owner's ports (plan 3.2). */
const FORBIDDEN: readonly PortRange[] = [
  [8765, 8784],
  [3000, 3000],
  [3100, 3100],
  [8080, 8080],
  [8089, 8089],
];

/** Ports handed out by this process and not yet released with `assertPortClosed`. */
const reserved = new Set<number>();

function checkRange([min, max]: PortRange): void {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) {
    throw new RangeError(`allocatePort: not a port range: [${String(min)}, ${String(max)}]`);
  }
  for (const [lo, hi] of FORBIDDEN) {
    if (min <= hi && max >= lo) {
      throw new RangeError(
        `allocatePort: range [${String(min)}, ${String(max)}] includes forbidden ports ${String(lo)}-${String(hi)}`,
      );
    }
  }
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

function startOfBlock(range: PortRange, isDefault: boolean): number {
  if (!isDefault) return range[0];
  const pool = Number.parseInt(process.env['VITEST_POOL_ID'] ?? '', 10);
  const index = Number.isInteger(pool) && pool >= 1 ? pool - 1 : 0;
  return range[0] + ((index * BLOCK_SIZE) % (range[1] - range[0] + 1));
}

/**
 * A free loopback port. Default range `VITEST_PORTS`: scanning starts at the block of 50 of this worker
 * (`18000 + ((VITEST_POOL_ID - 1) * 50) % 500`) and wraps around the range, so four forks never meet. Another range is
 * scanned from its start. A port stays reserved in this process until `assertPortClosed(port)`.
 */
export async function allocatePort(range?: PortRange): Promise<number> {
  const used = range ?? VITEST_PORTS;
  checkRange(used);
  const [min, max] = used;
  const span = max - min + 1;
  const start = startOfBlock(used, range === undefined);
  for (let i = 0; i < span; i += 1) {
    const port = min + ((start - min + i) % span);
    if (reserved.has(port)) continue;
    if (await isFree(port)) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`allocatePort: no free port in ${String(min)}-${String(max)}`);
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Throws when something still listens on `port`; releases the reservation of `allocatePort` either way. */
export async function assertPortClosed(port: number): Promise<void> {
  reserved.delete(port);
  if ((await accepts(port)) || !(await isFree(port))) {
    throw new Error(`port ${String(port)} is still in use`);
  }
}

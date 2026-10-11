// `server` section (01 section 1.6). There is no `devOrigins` and no `bindHost` key: the Origin allow-list stays the two
// loopback values (I-31, 05 5.4).
import { z } from 'zod';

import { type KeySpec, intKey, sectionSchema } from './section.ts';

const port: KeySpec<z.ZodNullable<z.ZodNumber>> = {
  // null = use the legacy `config.json` `port` (port selection, 01 4.11)
  schema: z.number().int().min(1).max(65535).nullable(),
  default: null,
};

export const ServerSectionKeys = {
  port,
  /** Ports tried: base .. base + portScan. */
  portScan: intKey(0, 99, 19),
  /** HTTP server `requestTimeout`. */
  requestTimeoutMs: intKey(1000, 600_000, 30_000),
  /** Graceful shutdown deadline (01 4.5). */
  shutdownGraceMs: intKey(100, 60_000, 5000),
};

export const ServerSectionSchema = sectionSchema(ServerSectionKeys);

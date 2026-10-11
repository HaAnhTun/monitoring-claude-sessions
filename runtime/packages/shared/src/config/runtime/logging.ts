// `logLevel`: the one top-level R key that is not a section (01 section 1.6). Rotation is not configuration: 05 S-LOG-6
// constants `LOG_ROTATE_BYTES` and `LOG_KEEP` (I-25). Registry note N5: `R_TOP_KEYS` needs no `logging` section; this
// module only holds the enum that the logger (05) and the config share.
import { z } from 'zod';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const LogLevelSchema = z.enum(LOG_LEVELS);

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

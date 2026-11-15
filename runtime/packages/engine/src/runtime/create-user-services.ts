// The real user services (CAW-31, design 06 1.7, design 02 sections 8 and 9, design 03 7.3, ADR 0084, 0091, 0093, 0094): what a user
// instance has that a task instance does not. `createInstanceRuntime` calls this factory only when `ctx.kind` is `user`; the result is
// `InstanceRuntime.user`, which the server reads for the census (stop guard, control op `terminals`), the access service (control op
// `access`, the cookie, the Bearer token of the reader routes), the terminal host (routes, socket, event feed) and the folder service.
//
// It joins the pieces that no single area owns:
//   - the terminal service (`createDefaultTerminalService`: the addon backend, the orphan registry under `ctx.mcsHome`);
//   - the folder service of the sidebar, and the linker that tells which monitored session a terminal is (its registry snapshot is
//     shared, the importer hint is `ingest.hintSession`, the process table is `listDescendantPids`);
//   - the folder picker (the Windows dialog; the fake one of the testkit under the test hook);
//   - the terminal host over them, and the access service (the control token is read from `run/control.token`, which boot writes
//     after the runtime was created, so it is read at each check).
// Three components start in this order and stop in the reverse order: `folders`, `terminal-link`, `terminal`. The terminal one
// sweeps the registry of a dead run first (at most 10 s; a failing or slow sweep never keeps the app down), registers the
// synchronous kill of every process at `process.on('exit')`, and at stop kills every session (`shutdown`), takes the hook off and
// closes the host. The fake-terminals test hook is NOT applied here: the server wraps the census of `runtime.user` once.
// Nothing here logs a name, a path, a code or a token: events carry a count or a code word at most.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Stmt } from '../db/driver.ts';
import { createRegistrySnapshot, type RegistrySnapshot } from '../external/registry.ts';
import { createFolderService, type FolderServiceDeps } from '../folders/service.ts';
import { createTerminalLinker } from '../link/linker.ts';
import type { ProcessTreePort } from '../link/types.ts';
import { listDescendantPids, pidAlive } from '../platform/process.ts';
import { createDefaultTerminalService, type DefaultTerminalOptions } from '../terminal/default.ts';
import { createFolderPicker, type FolderPickerPort } from '../terminal/folder-picker.ts';
import { createTerminalHost } from '../terminal/host.ts';
import type { TerminalService } from '../terminal/manager.ts';
import { assertNotLink } from '../workspace/fsio.ts';
import { createAccessService } from './access-service.ts';
import type { InstanceContext } from './context.ts';
import type { IngestService, RuntimeComponent } from './instance-runtime.ts';
import type { UserServices } from './user-services.ts';

/** How long the start waits for the sweep of the registry of a dead run (design 01 section 5). */
export const SWEEP_BUDGET_MS = 10_000;

/** A control token file is 64 hex digits and a line feed; a larger file is not one. */
const TOKEN_FILE_MAX_BYTES = 4096;
const CONTROL_TOKEN_RE = /^[0-9a-f]{64}$/;

/** The part of `process` the exit hook needs; a test passes a script. */
export interface ExitHook {
  on(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

/** What a test replaces; production passes nothing. */
export interface CreateUserServicesOptions {
  /** Replaces the whole terminal service (a script). Default: `createDefaultTerminalService` with `terminal` below. */
  readonly terminalService?: TerminalService;
  /** Options of the default terminal service: a scripted backend, the environment of the children, the platform. */
  readonly terminal?: Pick<
    DefaultTerminalOptions,
    'backend' | 'platform' | 'arch' | 'release' | 'env' | 'home' | 'load' | 'mcsHome'
  >;
  /** The folder dialog; `null` for none. Default: `createFolderPicker` (the Windows dialog, or the fake one under the test hook). */
  readonly picker?: FolderPickerPort | null;
  /** The environment the picker reads its test hook from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces pieces of the folder service (the DA memory, the file system). */
  readonly folders?: FolderServiceDeps;
  /** The registry of the Claude home, shared by the linker and the folder service. Default: a snapshot over `ctx.claudeHome`. */
  readonly registry?: Pick<RegistrySnapshot, 'read'>;
  /** The process table of the linker. Default: `listDescendantPids`. */
  readonly tree?: ProcessTreePort;
  /** Whether a pid is alive (the registry and the linker). Default: the real probe. */
  readonly pidAlive?: (pid: number) => boolean;
  /** The control token for the Bearer check; `null` while there is none. Default: `run/control.token` of the instance. */
  readonly controlToken?: () => string | null;
  /** How long the start waits for the sweep. Default `SWEEP_BUDGET_MS`. */
  readonly sweepBudgetMs?: number;
  /** Default: `process`. */
  readonly exitHook?: ExitHook;
}

/**
 * The control token of the instance as a function that reads it at each call: boot writes `run/control.token` after the runtime
 * (and so this factory) was created, and a new boot replaces it. A link, a missing, unreadable or oversized file and any content
 * that is not 64 lower-case hex digits are `null`. Synchronous (the access service asks it synchronously) and cheap: one small file.
 */
function controlTokenOf(file: string): () => string | null {
  return () => {
    try {
      assertNotLink(file);
      if (statSync(file).size > TOKEN_FILE_MAX_BYTES) return null;
      const text = readFileSync(file, 'utf8').trim();
      return CONTROL_TOKEN_RE.test(text) ? text : null;
    } catch {
      return null;
    }
  };
}

/** The importer hint and the database fallback of the linker, over the query layer of the context. */
function sessionQueries(ctx: InstanceContext): {
  sessionKnown: (sessionUid: string) => boolean;
  sessionsSince: (projectKey: string, sinceMs: number) => readonly string[];
} {
  // prepared at the first use: only the fallback after the fast window asks, and most terminals link long before
  let since: Stmt<{ uid: string }> | null = null;
  return {
    sessionKnown: (sessionUid) => ctx.queries.resumeFacts(ctx.scope, sessionUid) !== null,
    sessionsSince: (projectKey, sinceMs) => {
      since ??= ctx.db.driver.prepare<{ uid: string }>(
        `SELECT s.session_uid AS uid FROM sessions s JOIN projects p ON p.id = s.project_id
          WHERE p.project_key = :key AND s.first_seen_at >= :since
          ORDER BY s.first_seen_at, s.session_uid LIMIT 50`,
      );
      return since.all({ key: projectKey, since: sinceMs }).map((row) => row.uid);
    },
  };
}

export function createUserServices(
  ctx: InstanceContext,
  // the part of the runtime's services that the linker needs: the importer hint (a `RuntimeServices` is assignable to it)
  services: { readonly ingest: Pick<IngestService, 'hintSession'> },
  options: CreateUserServicesOptions = {},
): UserServices {
  const alive = options.pidAlive ?? pidAlive;
  const exitHook: ExitHook = options.exitHook ?? process;
  const sweepBudgetMs = options.sweepBudgetMs ?? SWEEP_BUDGET_MS;

  const terminal: TerminalService =
    options.terminalService ??
    createDefaultTerminalService({
      config: ctx.config.runtime.terminal,
      logger: ctx.logger,
      clock: ctx.clock,
      // the orphan registry lives under the home the instance was built with, which a test sets without touching `process.env`
      mcsHome: ctx.mcsHome,
      ...options.terminal,
    });

  const registry =
    options.registry ??
    createRegistrySnapshot({ claudeHome: ctx.claudeHome, pidAlive: alive, now: () => ctx.clock.now() });
  const tree: ProcessTreePort = options.tree ?? {
    descendants: async (rootPid) => {
      const found = await listDescendantPids(rootPid);
      return found === null ? null : new Set(found);
    },
  };
  const linker = createTerminalLinker({
    registry,
    tree,
    clock: ctx.clock,
    config: ctx.config.runtime.projects,
    ...sessionQueries(ctx),
    hintSession: (sessionUid) => {
      services.ingest.hintSession(sessionUid);
    },
    pidAlive: alive,
    logger: ctx.logger,
  });
  const folders = createFolderService(ctx, { linker, registry, ...options.folders });
  const picker =
    options.picker !== undefined
      ? options.picker
      : createFolderPicker(options.env === undefined ? {} : { env: options.env });
  const host = createTerminalHost({ service: terminal, folders, linker, picker, clock: ctx.clock });
  const access = createAccessService({
    clock: ctx.clock,
    controlToken: options.controlToken ?? controlTokenOf(path.join(ctx.instanceDir, 'run', 'control.token')),
  });

  // ---- the exit hook and the sweep ---------------------------------------------------------------------------------------

  /** `process.on('exit')`: no await and no spawn is possible there, only a synchronous kill of every process that may still run. */
  const onExit = (): void => {
    terminal.emergencyKillSync();
  };

  /** Waits for the sweep at most the budget. A slow or failing sweep is a warning (a code word, never the text of an error). */
  async function sweepWithinBudget(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, sweepBudgetMs);
    });
    try {
      const swept = Promise.resolve()
        .then(() => terminal.sweepOrphans())
        .then(
          () => 'done' as const,
          () => 'failed' as const,
        );
      const outcome = await Promise.race([swept, budget]);
      if (outcome === 'late') ctx.logger.warn('terminal_sweep_budget', { durationMs: sweepBudgetMs });
      else if (outcome === 'failed') ctx.logger.warn('terminal_sweep_failed', { code: 'sweep_failed' });
    } finally {
      clearTimeout(timer);
    }
  }

  const components: readonly RuntimeComponent[] = [
    { name: 'folders', start: () => folders.start(), stop: () => folders.stop() },
    {
      name: 'terminal-link',
      start: () => {
        linker.start();
      },
      stop: () => linker.stop(),
    },
    {
      name: 'terminal',
      start: async () => {
        // registered first: a crash during the sweep must not leave a process behind either
        exitHook.on('exit', onExit);
        await sweepWithinBudget();
      },
      stop: async () => {
        exitHook.off('exit', onExit);
        try {
          // the sessions end here, so their links are forgotten and their viewers told before the host lets go
          await terminal.shutdown();
        } finally {
          host.close();
        }
      },
    },
  ];

  return {
    census: host.census,
    access,
    accessService: access,
    terminal: host,
    folders,
    components,
  };
}

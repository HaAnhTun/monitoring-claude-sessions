// `ensureUserInstance` (06 1.4): the user-wide instance is an ordinary workspace of kind `user`; this makes it on first use and
// reuses it afterwards. The staging-folder transaction of `initWorkspace` and the task mutex make two concurrent callers safe.
import { mkdir } from 'node:fs/promises';

import { McsError, instanceKindOf, type InstanceFile } from '@mcs/shared';

import { type OpContext, openWorkspace } from '../ops/workspace.ts';
import { adoptWorkspace, readInstanceFile } from '../workspace/adopt.ts';
import { assertNotLink, writeWorkspaceFile } from '../workspace/fsio.ts';
import { initWorkspace } from '../workspace/init.ts';
import { listWorkspaceSlugs } from '../workspace/list.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { USER_DEFAULT_PORT, USER_INSTANCE_NAME, USER_INSTANCE_SLUG, userRootOf } from './paths.ts';

export interface EnsureUserInstanceResult {
  readonly ws: WorkspaceRef;
  readonly instance: InstanceFile;
  /** True when this call made the workspace. */
  readonly created: boolean;
}

export interface EnsureUserInstanceDeps {
  /** Test seam: the instance id of a new instance. */
  readonly newId?: () => string;
}

const DESCRIPTION = 'The user-wide Claude Agent Workspace instance. Created by caw; do not rename.';

/** What `init` writes into `README.md` talks about a monitoring task, which this is not. */
const README_TEXT =
  `# ${USER_INSTANCE_NAME}\n\n` +
  'This folder is the user-wide instance of the Claude Agent Workspace: one per Windows user, created by `caw` the first time it is needed. ' +
  'It holds the database of session metadata, the audit trail, the logs and the run files of that one instance. Do not rename or move it.\n\n' +
  '- `task.json` identity, `config.json` overrides of the shared defaults (the port), `runtime.json` Node runtime overrides, `instance.json` runtime identity (`kind` is `user`), `audit/` change and decision log, `data/` database, `logs/` runtime logs, `run/` control token and browser profile.\n' +
  '- Inspect: `caw status`, `caw config get`, `caw check`.\n' +
  '- Never copy transcripts here; they are read in place.\n';

/**
 * The user instance of this person, made when it does not exist:
 *
 * 1. the user root `<MCS_HOME>/instances` is created, a link there is refused (`WORKSPACE_SYMLINK`);
 * 2. when the root has a workspace `user`, it is reused: an `instance.json` of kind `user` is left as it is, a workspace
 *    without one is adopted as a user instance, any other kind is refused (`WORKSPACE_INVALID`). `port` is never passed
 *    again: `init` would answer `WORKSPACE_EXISTS_CONFIG_DIFFERS` once the person has changed it;
 * 3. otherwise `initWorkspace` makes it with the title, the slug `user`, the default port 7690 and `kind: 'user'`, and the
 *    README is replaced once by the text of a user instance.
 *
 * Only `ctx.env`, `ctx.clock` and the folders of the repository are used; `ctx.repo` and `ctx.root` are not read, so any
 * context of the caller will do (`userOpContext` builds the one that matches).
 */
export async function ensureUserInstance(
  ctx: OpContext,
  deps: EnsureUserInstanceDeps = {},
): Promise<EnsureUserInstanceResult> {
  const root = userRootOf(ctx.env);
  assertNotLink(root);
  await mkdir(root, { recursive: true });

  if ((await listWorkspaceSlugs(root)).includes(USER_INSTANCE_SLUG)) {
    const ws = await openWorkspace({ root }, USER_INSTANCE_SLUG);
    const existing = await readInstanceFile(ws);
    if (existing !== null && instanceKindOf(existing) !== 'user') {
      throw new McsError(
        'WORKSPACE_INVALID',
        `${ws.dir} is a ${instanceKindOf(existing)} instance, not the user instance; the folder name 'user' is reserved`,
        { details: { slug: ws.slug } },
      );
    }
    const adoption = await adoptWorkspace(ws, {
      clock: ctx.clock,
      kind: 'user',
      ...(deps.newId === undefined ? {} : { newId: deps.newId }),
    });
    return { ws, instance: adoption.instance, created: false };
  }

  const result = await initWorkspace({
    repo: root,
    root,
    name: USER_INSTANCE_NAME,
    slug: USER_INSTANCE_SLUG,
    description: DESCRIPTION,
    port: USER_DEFAULT_PORT,
    kind: 'user',
    clock: ctx.clock,
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
  if (result.created) await writeWorkspaceFile(workspacePath(result.ws, 'README.md'), README_TEXT);
  return { ws: result.ws, instance: result.instance, created: result.created };
}

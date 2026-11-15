// The folder routes (CAW-29, design 03 7.2, ADR 0089): the list the sidebar shows, the add of a folder by hand and its removal.
// Every one is `access: 'session'` (folder paths and DA summaries are private); the access chain of `registerRoute` guards them
// and the module is mounted for the user instance only (the boot code does that, this file does not edit `app.ts`).
//   - A handler asks the folder service of the engine and shapes nothing: the service answers with the rows of the wire schema.
//   - The service's `FolderError` is turned into the code of the catalogue here: `folder_invalid` 400 (the reason as
//     `details[0].issue`, never the path), `folder_limit` 409, `folder_not_found` 404; `state_unwritable` is a failure of the
//     machine, so it stays an internal error and the adapter records it with a code only.
//   - Logging: none. A path, a key or a summary never reaches a log line or an error message.
import type { FolderService } from '@mcs/engine';
import { routes } from '@mcs/shared';

import { ApiError } from '../errors.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

export interface FolderRoutesOptions {
  /** The folder service of the user instance. */
  readonly folders: Pick<FolderService, 'list' | 'add' | 'remove'>;
}

function stringProperty(value: object, name: string): string | undefined {
  const property: unknown = Reflect.get(value, name);
  return typeof property === 'string' ? property : undefined;
}

/**
 * The engine's `FolderError`, recognised by its name (source and build copies of the class both map), as the other routes do
 * for the errors of the engine. Anything else is rethrown untouched and becomes `internal_error`.
 */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error.name !== 'FolderError' && error.constructor.name !== 'FolderError')) {
      throw error;
    }
    const code = stringProperty(error, 'code');
    if (code === 'folder_invalid') {
      const issue = stringProperty(error, 'issue');
      throw new ApiError('folder_invalid', {
        ...(issue === undefined ? {} : { details: [{ path: 'path', issue }] }),
        cause: error,
      });
    }
    if (code === 'folder_limit') throw new ApiError('folder_limit', { cause: error });
    if (code === 'folder_not_found') throw new ApiError('folder_not_found', { cause: error });
    throw error;
  }
}

/** The module that mounts `listFolders`, `addFolder` and `removeFolder`. */
export function createFolderRoutes(options: FolderRoutesOptions): RouteModule {
  const { folders } = options;
  return (app) => {
    registerRoute(app, routes.listFolders, () => folders.list());
    registerRoute(app, routes.addFolder, ({ body }) => answering(() => folders.add(body.path)));
    registerRoute(app, routes.removeFolder, ({ params }) => answering(() => folders.remove(params.key)));
  };
}

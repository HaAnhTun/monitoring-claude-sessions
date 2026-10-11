// The two file system calls of the external evidence readers (02 7.10), behind one seam so that a test can spy on exactly
// which files are opened (T-LF-53: a `.key` file is never opened). Nothing here walks a folder tree: `readdir` is one level.
import { readdir } from 'node:fs/promises';

import { readSmallFile } from '../platform/fsx.ts';

export interface ExternalFs {
  /** The names in `dir` (one level); an unreadable or missing folder is an empty list. */
  readdir(dir: string): Promise<readonly string[]>;
  /** The bytes of a file of at most `maxBytes`; `null` when it is missing, too large or unreadable. */
  readSmall(file: string, maxBytes: number): Promise<Buffer | null>;
}

export const nodeExternalFs: ExternalFs = {
  readdir: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  readSmall: async (file, maxBytes) => {
    try {
      return await readSmallFile(file, maxBytes);
    } catch {
      return null;
    }
  },
};

/** What one poll of an external source found. The state of the reader changes only in `commit()`, after the events were taken. */
export interface ExternalPoll<E> {
  readonly events: readonly E[];
  /** Files that existed but could not be read or parsed: `EXTERNAL_READ_FAILED`, the observation is ignored (02 4.8). */
  readonly readFailures: number;
  /** Call once the events were handed to the writer; a refused batch is simply not committed and comes again at the next poll. */
  commit(): void;
}

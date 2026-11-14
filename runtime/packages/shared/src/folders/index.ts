// Folder helpers of the projects area: pure, isomorphic functions shared by the engine, the server, the CLI and the web.
export { ACTIVITY_MARKS, activityMarkOf, parseDaTimestamp, sameLocalDay, type ActivityMark } from './activity.ts';
export {
  FOLDER_PATH_ISSUES,
  MAX_FOLDER_PATH_CHARS,
  folderPathIssue,
  folderPathKey,
  lastSegment,
  windowsFolderPath,
  type FolderPathIssue,
} from './path.ts';
export { relativeTimeOf, type RelativeTime } from './relative-time.ts';

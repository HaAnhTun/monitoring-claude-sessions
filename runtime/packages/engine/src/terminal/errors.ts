// The one error type of the terminal service (design 01 section 3.2). The message is a fixed English sentence per code: it
// never holds a path, a session name, an argument or the text of a node-pty error (those carry file names). The cause is kept
// for a debugger and is never logged.

/** Every code, in the order of the design. The server maps them to HTTP statuses and socket close codes. */
export const TERMINAL_ERROR_CODES = [
  // the backend is not usable
  'UNSUPPORTED_OS',
  'NATIVE_MISSING',
  'NATIVE_LOAD_FAILED',
  // launch
  'CLAUDE_NOT_FOUND',
  'COMMAND_UNSUPPORTED',
  'ARGS_UNSAFE',
  // working folder
  'FOLDER_INVALID',
  'FOLDER_NOT_FOUND',
  // create
  'SESSION_LIMIT',
  'SPAWN_FAILED',
  'START_TIMEOUT',
  // use
  'SESSION_NOT_FOUND',
  'SESSION_ENDED',
  'NAME_INVALID',
  'MESSAGE_TOO_LARGE',
  'SHUTTING_DOWN',
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<TerminalErrorCode, string>> = {
  UNSUPPORTED_OS: 'The terminal is not supported on this operating system.',
  NATIVE_MISSING: 'The terminal component is missing from this installation.',
  NATIVE_LOAD_FAILED: 'The terminal component could not be loaded.',
  CLAUDE_NOT_FOUND: 'The claude command was not found on the search path.',
  COMMAND_UNSUPPORTED: 'The claude command is of a kind the terminal cannot start.',
  ARGS_UNSAFE: 'An argument cannot be passed safely to the claude command.',
  FOLDER_INVALID: 'The folder is not a valid working folder.',
  FOLDER_NOT_FOUND: 'The folder does not exist.',
  SESSION_LIMIT: 'The limit of terminal sessions is reached.',
  SPAWN_FAILED: 'The terminal process could not be started.',
  START_TIMEOUT: 'The terminal process did not start in time.',
  SESSION_NOT_FOUND: 'There is no terminal session with this name.',
  SESSION_ENDED: 'The terminal session has ended.',
  NAME_INVALID: 'The session name is not valid.',
  MESSAGE_TOO_LARGE: 'The input is too large.',
  SHUTTING_DOWN: 'The terminal service is shutting down.',
};

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'TerminalError';
    this.code = code;
  }
}

export function isTerminalError(value: unknown): value is TerminalError {
  return value instanceof TerminalError;
}

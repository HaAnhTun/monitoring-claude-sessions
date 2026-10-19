// Fixtures of the hooks installer merge matrix (T-IN-01 to T-IN-04): synthetic settings files, each with the settings object
// that an install must produce. The files are built in code (not stored as .json) because the line endings, the byte order
// mark and the odd spacing that the cases are about do not survive a checkout with line-ending conversion or a formatter.
// Every path, command and name is a placeholder (rule 12): nothing here comes from a real settings file.
import type { HooksFailureReason } from '@mcs/shared';

export const FIXTURE_NODE = 'C:/FIXTURE/node.exe';
export const FIXTURE_SCRIPT = 'C:/FIXTURE/mcs-home/hooks/mcs-hook.mjs';
export const OLD_SCRIPT = 'C:/FIXTURE/old-skill/scripts/mcs-hook.mjs';
export const OLDER_SCRIPT = 'D:/FIXTURE/older-skill/scripts/mcs-hook.mjs';

/** The events of the small `desired` map that the merge cases use (the full set of 21 has its own test). */
export const MATRIX_EVENTS = ['SessionStart', 'PreToolUse', 'SessionEnd'] as const;

type Json = Record<string, unknown>;

/** Our handler for one event, written out by hand (it must not be produced by the code under test). */
export function ourHandler(event: string, script: string = FIXTURE_SCRIPT): Json {
  const isAsync = event === 'PreToolUse';
  return {
    type: 'command',
    command: FIXTURE_NODE,
    args: ['--no-warnings', script, '--mcs-hook', event, ...(isAsync ? ['--async'] : [])],
    timeout: event === 'SessionEnd' ? 2 : 5,
    ...(isAsync ? { async: true } : {}),
  };
}

export function ourGroup(event: string, script: string = FIXTURE_SCRIPT): Json {
  return { hooks: [ourHandler(event, script)] };
}

export const USER_HANDLER = (name: string): Json => ({ type: 'command', command: `echo FIXTURE ${name}` });
/** A user script that is called hook.js: never ours, because only the marker argument counts (T-IN-04). */
export const USER_HOOK_JS: Json = {
  type: 'command',
  command: 'node',
  args: ['C:/FIXTURE/user/hook.js', 'SessionStart'],
};

/** The text the base layout gives an object: two spaces, LF, final newline. */
export function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface Expect {
  readonly changed: boolean;
  /** The settings object after an install; for a case that changes nothing it is the parsed input. */
  readonly obj: Json;
  readonly added: readonly string[];
  readonly replaced: readonly string[];
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

export interface PlanCase {
  readonly id: string;
  /** `null` is a missing file. */
  readonly input: string | null;
  /** The input holds none of our handlers (so an uninstall of the install result gives the input back). */
  readonly pristine: boolean;
  readonly install: Expect | { readonly refusal: HooksFailureReason };
}

const ALL_ADDED = [...MATRIX_EVENTS];
const FRESH_HOOKS = {
  SessionStart: [ourGroup('SessionStart')],
  PreToolUse: [ourGroup('PreToolUse')],
  SessionEnd: [ourGroup('SessionEnd')],
};
const fresh = (extra: Json = {}): Expect => ({
  changed: true,
  obj: { ...extra, hooks: FRESH_HOOKS },
  added: ALL_ADDED,
  replaced: [],
  removed: [],
  kept: [],
});

const UNRELATED: Json = { theme: 'dark', env: { FIXTURE_NAME: 'FIXTURE value' }, retries: 3 };
const UNRELATED_INSTALLED: Json = { ...UNRELATED, hooks: FRESH_HOOKS };

const USER_HOOKS_INPUT: Json = {
  hooks: {
    SessionStart: [{ hooks: [USER_HANDLER('start')] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [USER_HANDLER('bash')] }, { hooks: [USER_HANDLER('any')] }],
    Stop: [{ hooks: [USER_HANDLER('stop')] }],
  },
  model: 'FIXTURE-model',
};

const OLD_ENTRIES_INPUT: Json = {
  hooks: {
    SessionStart: [{ hooks: [ourHandler('SessionStart', OLD_SCRIPT)] }],
    PreToolUse: [
      { hooks: [ourHandler('PreToolUse', OLD_SCRIPT)] },
      { hooks: [ourHandler('PreToolUse', OLDER_SCRIPT)] },
    ],
    Stop: [{ matcher: 'x', hooks: [USER_HANDLER('stop'), ourHandler('Stop', OLD_SCRIPT)] }],
    Notification: [{ hooks: [ourHandler('Notification', OLD_SCRIPT)] }],
  },
};

export const PLAN_CASES: readonly PlanCase[] = [
  { id: 'missing file', input: null, pristine: true, install: fresh() },
  { id: 'empty file', input: '', pristine: true, install: fresh() },
  { id: 'whitespace only', input: '  \n\n', pristine: true, install: fresh() },
  { id: 'empty object', input: '{}\n', pristine: true, install: fresh() },
  { id: 'empty object without final newline', input: '{}', pristine: true, install: fresh() },
  {
    id: 'unrelated keys',
    input: pretty(UNRELATED),
    pristine: true,
    install: fresh(UNRELATED),
  },
  {
    id: 'user hooks on the same events, with and without matchers',
    input: pretty(USER_HOOKS_INPUT),
    pristine: true,
    install: {
      changed: true,
      obj: {
        hooks: {
          SessionStart: [{ hooks: [USER_HANDLER('start')] }, ourGroup('SessionStart')],
          PreToolUse: [
            { matcher: 'Bash', hooks: [USER_HANDLER('bash')] },
            { hooks: [USER_HANDLER('any')] },
            ourGroup('PreToolUse'),
          ],
          Stop: [{ hooks: [USER_HANDLER('stop')] }],
          SessionEnd: [ourGroup('SessionEnd')],
        },
        model: 'FIXTURE-model',
      },
      added: ALL_ADDED,
      replaced: [],
      removed: [],
      kept: [],
    },
  },
  {
    id: 'a user script named hook.js is not ours',
    input: pretty({ hooks: { SessionStart: [{ hooks: [USER_HOOK_JS] }] } }),
    pristine: true,
    install: {
      changed: true,
      obj: {
        hooks: {
          SessionStart: [{ hooks: [USER_HOOK_JS] }, ourGroup('SessionStart')],
          PreToolUse: [ourGroup('PreToolUse')],
          SessionEnd: [ourGroup('SessionEnd')],
        },
      },
      added: ALL_ADDED,
      replaced: [],
      removed: [],
      kept: [],
    },
  },
  {
    id: 'our old entries with other paths',
    input: pretty(OLD_ENTRIES_INPUT),
    pristine: false,
    install: {
      changed: true,
      obj: {
        hooks: {
          // the user's group of Stop stays without our handler; the events that held only ours leave and come back last
          Stop: [{ matcher: 'x', hooks: [USER_HANDLER('stop')] }],
          SessionStart: [ourGroup('SessionStart')],
          PreToolUse: [ourGroup('PreToolUse')],
          SessionEnd: [ourGroup('SessionEnd')],
        },
      },
      added: ['SessionEnd'],
      replaced: ['SessionStart', 'PreToolUse'],
      removed: ['Stop', 'Notification'],
      kept: [],
    },
  },
  {
    id: 'our shell-form entry is replaced',
    input: pretty({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node "C:/FIXTURE/old-skill/mcs-hook.mjs" --mcs-hook SessionStart' }] },
        ],
      },
    }),
    pristine: false,
    install: {
      changed: true,
      obj: { hooks: FRESH_HOOKS },
      added: ['PreToolUse', 'SessionEnd'],
      replaced: ['SessionStart'],
      removed: [],
      kept: [],
    },
  },
  {
    id: 'already installed',
    input: pretty(UNRELATED_INSTALLED),
    pristine: false,
    install: { changed: false, obj: UNRELATED_INSTALLED, added: [], replaced: [], removed: [], kept: ALL_ADDED },
  },
  {
    id: 'a group of the user added below ours does not move ours',
    input: pretty({
      hooks: { SessionStart: [ourGroup('SessionStart'), { hooks: [USER_HANDLER('later')] }] },
    }),
    pristine: false,
    install: {
      changed: true,
      obj: {
        hooks: {
          SessionStart: [ourGroup('SessionStart'), { hooks: [USER_HANDLER('later')] }],
          PreToolUse: [ourGroup('PreToolUse')],
          SessionEnd: [ourGroup('SessionEnd')],
        },
      },
      added: ['PreToolUse', 'SessionEnd'],
      replaced: [],
      removed: [],
      kept: ['SessionStart'],
    },
  },
  {
    id: 'our handler in a group with a matcher of the user is kept as it is',
    input: pretty({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [ourHandler('SessionStart')] }] } }),
    pristine: false,
    install: {
      changed: true,
      obj: {
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [ourHandler('SessionStart')] }],
          PreToolUse: [ourGroup('PreToolUse')],
          SessionEnd: [ourGroup('SessionEnd')],
        },
      },
      added: ['PreToolUse', 'SessionEnd'],
      replaced: [],
      removed: [],
      kept: ['SessionStart'],
    },
  },
  {
    id: 'two identical entries of ours become one',
    input: pretty({ hooks: { SessionStart: [ourGroup('SessionStart'), ourGroup('SessionStart')] } }),
    pristine: false,
    install: {
      changed: true,
      obj: { hooks: FRESH_HOOKS },
      added: ['PreToolUse', 'SessionEnd'],
      replaced: ['SessionStart'],
      removed: [],
      kept: [],
    },
  },
  {
    id: 'an event name this version does not know, with a value that is not an array, is left alone',
    input: pretty({ hooks: { FixtureUnknownEvent: {} } }),
    pristine: true,
    install: {
      changed: true,
      obj: {
        hooks: {
          FixtureUnknownEvent: {},
          SessionStart: [ourGroup('SessionStart')],
          PreToolUse: [ourGroup('PreToolUse')],
          SessionEnd: [ourGroup('SessionEnd')],
        },
      },
      added: ALL_ADDED,
      replaced: [],
      removed: [],
      kept: [],
    },
  },
  { id: 'invalid JSON', input: '{ "hooks": ', pristine: true, install: { refusal: 'SETTINGS_INVALID_JSON' } },
  {
    id: 'a comment',
    input: '{\n  // note\n  "a": 1\n}\n',
    pristine: true,
    install: { refusal: 'SETTINGS_INVALID_JSON' },
  },
  { id: 'top level is an array', input: '[]\n', pristine: true, install: { refusal: 'SETTINGS_NOT_OBJECT' } },
  { id: 'top level is null', input: 'null', pristine: true, install: { refusal: 'SETTINGS_NOT_OBJECT' } },
  {
    id: 'hooks is an array',
    input: '{"hooks": []}',
    pristine: true,
    install: { refusal: 'SETTINGS_HOOKS_NOT_OBJECT' },
  },
  { id: 'hooks is null', input: '{"hooks": null}', pristine: true, install: { refusal: 'SETTINGS_HOOKS_NOT_OBJECT' } },
  {
    id: 'hooks.Stop is an object',
    input: '{"hooks": {"Stop": {}}}',
    pristine: true,
    install: { refusal: 'SETTINGS_EVENT_NOT_ARRAY' },
  },
  {
    id: 'hooks.SessionStart is null',
    input: '{"hooks": {"SessionStart": null}}',
    pristine: true,
    install: { refusal: 'SETTINGS_EVENT_NOT_ARRAY' },
  },
];

// ---- the same file in other layouts ---------------------------------------------------------------------------------------

export interface Layout {
  readonly id: string;
  /** Rewrites a base-layout text (two spaces, LF, final newline) into this layout. */
  readonly apply: (baseText: string) => string;
}

const BOM = '\uFEFF';

export const LAYOUTS: readonly Layout[] = [
  { id: 'CRLF', apply: (t) => t.replaceAll('\n', '\r\n') },
  { id: 'BOM', apply: (t) => BOM + t },
  { id: '4 spaces', apply: (t) => t.replace(/^( +)/gm, (spaces) => spaces.repeat(2)) },
  { id: 'tabs', apply: (t) => t.replace(/^( +)/gm, (spaces) => '\t'.repeat(spaces.length / 2)) },
  { id: 'no final newline', apply: (t) => t.replace(/\n$/, '') },
  {
    id: 'CRLF + BOM + 4 spaces',
    apply: (t) => BOM + t.replace(/^( +)/gm, (spaces) => spaces.repeat(2)).replaceAll('\n', '\r\n'),
  },
];

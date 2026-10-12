// What the global setup hands to the spec: the URL of the running instance and the values the pages must show. The setup
// runs in the runner process and the spec in a worker, so the hand-over is one environment variable holding JSON that the
// spec validates at this boundary. The check is hand-written: the e2e folder declares no schema library of its own.

export const SKELETON_ENV = 'MCS_E2E_SKELETON';

export interface EnvUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  turns: number;
}

export interface EnvToolCall {
  toolUseId: string;
  name: string;
  resultText: string | null;
  isError: boolean | null;
  agentId: string;
}

export interface EnvSession {
  id: string;
  label: string;
  state: 'turn_ended' | 'waiting_tool';
  pendingTools: number;
  inclSubagents: EnvUsage;
  toolCalls: EnvToolCall[];
}

/** Where the running instance lives: what the live helpers of the harness need to feed it or stop it (LF-7). */
export interface EnvPaths {
  mcsHome: string;
  claudeDir: string;
  repoDir: string;
  projectDir: string;
  slug: string;
}

export interface SkeletonEnvValue {
  baseUrl: string;
  paths: EnvPaths;
  expected: { sessions: EnvSession[] };
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(path: string, want: string): never {
  throw new Error(`${SKELETON_ENV}: ${path} must be ${want}`);
}

function objAt(value: unknown, path: string): Obj {
  if (!isObj(value)) return bad(path, 'an object');
  return value;
}

function strAt(obj: Obj, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string') return bad(`${path}.${key}`, 'a string');
  return value;
}

function numAt(obj: Obj, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad(`${path}.${key}`, 'a finite number');
  return value;
}

function strOrNullAt(obj: Obj, key: string, path: string): string | null {
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'string') return bad(`${path}.${key}`, 'a string or null');
  return value;
}

function boolOrNullAt(obj: Obj, key: string, path: string): boolean | null {
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'boolean') return bad(`${path}.${key}`, 'a boolean or null');
  return value;
}

function usageAt(value: unknown, path: string): EnvUsage {
  const obj = objAt(value, path);
  return {
    input: numAt(obj, 'input', path),
    output: numAt(obj, 'output', path),
    cacheCreation: numAt(obj, 'cacheCreation', path),
    cacheRead: numAt(obj, 'cacheRead', path),
    total: numAt(obj, 'total', path),
    turns: numAt(obj, 'turns', path),
  };
}

function toolCallAt(value: unknown, path: string): EnvToolCall {
  const obj = objAt(value, path);
  return {
    toolUseId: strAt(obj, 'toolUseId', path),
    name: strAt(obj, 'name', path),
    resultText: strOrNullAt(obj, 'resultText', path),
    isError: boolOrNullAt(obj, 'isError', path),
    agentId: strAt(obj, 'agentId', path),
  };
}

function sessionAt(value: unknown, path: string): EnvSession {
  const obj = objAt(value, path);
  const state = obj['state'];
  if (state !== 'turn_ended' && state !== 'waiting_tool') return bad(`${path}.state`, "'turn_ended' or 'waiting_tool'");
  const calls = obj['toolCalls'];
  if (!Array.isArray(calls)) return bad(`${path}.toolCalls`, 'an array');
  return {
    id: strAt(obj, 'id', path),
    label: strAt(obj, 'label', path),
    state,
    pendingTools: numAt(obj, 'pendingTools', path),
    inclSubagents: usageAt(obj['inclSubagents'], `${path}.inclSubagents`),
    toolCalls: calls.map((call: unknown, index) => toolCallAt(call, `${path}.toolCalls[${index}]`)),
  };
}

function pathsAt(value: unknown, path: string): EnvPaths {
  const obj = objAt(value, path);
  return {
    mcsHome: strAt(obj, 'mcsHome', path),
    claudeDir: strAt(obj, 'claudeDir', path),
    repoDir: strAt(obj, 'repoDir', path),
    projectDir: strAt(obj, 'projectDir', path),
    slug: strAt(obj, 'slug', path),
  };
}

/** Validates the parsed hand-over; the error names the first field that is missing or has the wrong type. */
export function parseSkeletonEnv(value: unknown): SkeletonEnvValue {
  const root = objAt(value, 'root');
  const expected = objAt(root['expected'], 'expected');
  const sessions = expected['sessions'];
  if (!Array.isArray(sessions) || sessions.length !== 2)
    return bad('expected.sessions', 'an array of exactly 2 sessions');
  return {
    baseUrl: strAt(root, 'baseUrl', 'root'),
    paths: pathsAt(root['paths'], 'paths'),
    expected: {
      sessions: sessions.map((session: unknown, index) => sessionAt(session, `expected.sessions[${index}]`)),
    },
  };
}

/** Reads and validates the hand-over of the global setup; a missing or malformed value names itself in the error. */
export function readSkeletonEnv(): SkeletonEnvValue {
  const raw = process.env[SKELETON_ENV];
  if (raw === undefined || raw === '') {
    throw new Error(`${SKELETON_ENV} is not set: the global setup did not start the skeleton instance`);
  }
  return parseSkeletonEnv(JSON.parse(raw));
}

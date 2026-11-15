// Which configuration keys do something (WP-105, R-8.10). Configuration validation accepts every key of the shipped defaults
// plus the nested keys of `ui`, `poll`, `limits`, `panels` and `attempts`; this table says what each one does, and which
// source file reads it, so that a key can never be "validated but never used" without the table saying so. The completeness
// and consumer tests (`key-support.test.ts`) keep it honest: a new key cannot be added unclassified, and a `supported` key
// must be read by the file that is named for it.
//
// `configKeyWarnings` turns a resolved configuration into warnings for `mcs doctor`. It is a pure function of its argument:
// it reads no file, and no message repeats a configured value.
import type { LegacyConfig } from './defaults.ts';

export type KeyStatus = 'supported' | 'partial' | 'unsupported';

export interface KeySupport {
  readonly status: KeyStatus;
  /** Source files below `packages/` that read the key (`engine/src/...`, `server/src/...` or `shared/src/...`); none for `unsupported`. */
  readonly consumers: readonly string[];
  /** One sentence: what the key does, or why it does nothing. */
  readonly note: string;
  /** `unsupported` keys only: the shipped default. A value equal to it is not worth a warning. */
  readonly defaultValue?: number;
}

const INGEST = 'engine/src/ingest/service.ts';
const QUERY = 'engine/src/query/index.ts';
const PANELS = 'engine/src/panels/service.ts';
const PANEL_ROUTE = 'server/src/routes/panels.ts';
/** Where a panel key is mapped to its `panels.<name>` configuration key (read by the route above). */
const PANEL_MAP = 'shared/src/api/panels.ts';
const PANEL_FILES = 'engine/src/panels/files.ts';

function supported(note: string, ...consumers: string[]): KeySupport {
  return { status: 'supported', consumers, note };
}

/** Dotted key to what it does. The top-level keys are those of `LegacyConfigFileSchema`; nested keys are listed as `parent.child`. */
export const CONFIG_KEY_SUPPORT: Readonly<Record<string, KeySupport>> = {
  schema_version: supported(
    'Gates the file format; a missing or unknown version is refused.',
    'engine/src/config/defaults.ts',
  ),
  title: supported('The name of the monitor in the page title and the instance information.', QUERY),
  port: supported('The port the instance listens on (a start option overrides it).', 'engine/src/config/resolve.ts'),
  repo: supported(
    'The repository the sessions belong to; relative panel paths are read against it.',
    'engine/src/config/resolve.ts',
  ),
  transcripts_dir: supported('The folder of transcript files; `auto` finds it from the repository.', INGEST),
  window_hours: supported('How far back sessions and events are shown.', QUERY, 'engine/src/query/sessions.ts'),
  active_seconds: supported(
    'How recent an event must be for a session to count as active.',
    'engine/src/lifecycle/facts.ts',
  ),
  pending_tool_grace_seconds: supported(
    'How long a tool call may stay open before the session is called stuck.',
    'engine/src/lifecycle/facts.ts',
  ),
  include_unmatched: supported(
    'Keeps sessions that no rule matched visible instead of hiding them.',
    'engine/src/projects/scope.ts',
  ),
  session_rules: supported(
    'Pattern rules that choose and label the sessions of this task.',
    'engine/src/ingest/transcripts/classify.ts',
  ),
  session_ids: supported('Session ids that are always part of this task.', 'engine/src/ingest/transcripts/classify.ts'),
  panels: supported('Switches the optional panels on and off.', PANEL_ROUTE, PANEL_MAP),
  live_log_globs: supported('Files shown by the logs panel and listed by discover.', PANEL_FILES),
  chain_log: supported(
    'The chain log file read by the chain log panel and the attempts ingestion.',
    PANEL_FILES,
    PANELS,
  ),
  ledger: supported('The ledger file shown by the ledger panel.', PANEL_FILES),
  stop_file: supported('A file whose presence the panels report as a stop request.', PANEL_FILES),
  attempts: supported(
    'How attempts are read from the chain log (needs `chain_log`).',
    'engine/src/panels/attempts/ingest.ts',
  ),
  watched_processes: supported('Process names listed by the machine panel.', PANELS),
  docker: supported('Whether the machine panel lists running containers.', PANELS),
  ui: supported('Default display preferences served to the page.', QUERY),
  poll: supported('How often the page refreshes each view when no stream is open.', QUERY),
  limits: supported('Size limits of the imported and shown data.', QUERY),

  'panels.machine': supported('The machine panel: memory, CPU, watched processes and containers.', PANEL_MAP, PANELS),
  'panels.git': supported('The git panel: branch, changes and recent commits.', PANEL_MAP),
  'panels.logs': supported('The logs panel (needs `live_log_globs`).', PANEL_MAP, PANEL_FILES),
  'panels.ledger': supported('The ledger panel (needs `ledger`).', PANEL_MAP, PANEL_FILES),
  'panels.chain_log': supported('The chain log panel (needs `chain_log`).', PANEL_MAP, PANEL_FILES),
  'panels.attempts': supported('The attempts panel (needs `attempts` and `chain_log`).', PANEL_MAP, PANELS),

  'ui.theme': supported('The default colour theme.', QUERY),
  'ui.density': supported('The default row density.', QUERY),
  'ui.newest_first': supported('Lists newest events and sessions first.', QUERY),
  'ui.show_tools': supported('Shows tool calls in the timeline by default.', QUERY),
  'ui.show_thinking': supported('Shows thinking blocks in the timeline by default.', QUERY),
  'ui.show_prompts': supported('Shows prompts in the timeline by default.', QUERY),

  'poll.events_ms': supported('Refresh interval of the open transcript.', QUERY),
  'poll.sessions_ms': supported('Refresh interval of the session list.', QUERY),
  'poll.machine_ms': supported('Refresh interval of the machine panel.', QUERY),
  'poll.logs_ms': supported('Refresh interval of the logs panel.', QUERY),
  'poll.overview_ms': supported('Refresh interval of the overview, git, ledger and chain log panels.', QUERY),
  'poll.attempts_ms': supported('Refresh interval of the attempts panel.', QUERY),
  'poll.stale_after_ms': supported('How long without news before the page calls its data stale.', QUERY),

  'limits.event_window_mb': supported(
    'How much of the end of a transcript file is imported first (megabytes).',
    'shared/src/config/runtime/index.ts',
    INGEST,
  ),
  'limits.max_events': {
    status: 'unsupported',
    consumers: [],
    note: 'the timeline is paged, so there is no cap on the number of events',
    defaultValue: 20000,
  },
  'limits.text_chars': supported(
    'How many characters of one text are kept and shown.',
    QUERY,
    'engine/src/transcript/entries.ts',
  ),
  'limits.usage_scan_budget_ms': {
    status: 'unsupported',
    consumers: [],
    note: 'token usage is read incrementally as transcripts are imported, so there is no scan budget',
    defaultValue: 1500,
  },
  'limits.usage_max_mb': supported(
    'How much older transcript data is read to back-fill token usage (megabytes).',
    'shared/src/config/runtime/index.ts',
    INGEST,
  ),

  'attempts.start': supported(
    'Pattern that opens an attempt in the chain log.',
    'engine/src/panels/attempts/ingest.ts',
  ),
  'attempts.end': supported('Pattern that closes an attempt in the chain log.', 'engine/src/panels/attempts/ingest.ts'),
  'attempts.label_prefix': supported(
    'Text put before the label of every attempt.',
    'engine/src/panels/attempts/ingest.ts',
  ),
  'attempts.time_format': supported('The time format of the chain log lines.', 'engine/src/panels/attempts/parse.ts'),
};

export type ConfigKeyWarningCode = 'CONFIG_KEY_UNSUPPORTED' | 'CONFIG_KEY_UNKNOWN' | 'CONFIG_KEY_INERT';

export interface ConfigKeyWarning {
  /** The dotted key the warning is about. */
  readonly key: string;
  readonly code: ConfigKeyWarningCode;
  /** English, names the key, never contains a configured value. */
  readonly message: string;
}

/** The part of the merged configuration the rules look at; every field may be missing. */
export type ConfigKeyInput = Readonly<Partial<LegacyConfig>> & Readonly<Record<string, unknown>>;

export interface ConfigKeyOptions {
  /**
   * The dotted keys the task itself sets (provenance `config`). The shipped defaults switch the logs panel on without any
   * `live_log_globs`, and list watched processes and Docker without the machine panel being a choice, so the rules that would
   * fire on a default alone look at this set. Without it every key counts as set.
   */
  readonly explicit?: ReadonlySet<string>;
}

const CONTAINERS = ['panels', 'ui', 'poll', 'limits', 'attempts'] as const;
const KEY_SHOWN_MAX = 60;

/** A key as written in a message: printable ASCII only, clipped. A key is configuration text and may hold anything. */
function shown(key: string): string {
  let out = '';
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code < 0x7f ? ch : '?';
    if (out.length >= KEY_SHOWN_MAX) return `${out}...`;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(monitor: ConfigKeyInput, dotted: string): unknown {
  const [top, child] = dotted.split('.');
  const parent: unknown = top === undefined ? undefined : monitor[top];
  if (child === undefined) return parent;
  return isRecord(parent) && Object.hasOwn(parent, child) ? parent[child] : undefined;
}

function knownChildren(container: string): string[] {
  const prefix = `${container}.`;
  return Object.keys(CONFIG_KEY_SUPPORT)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

function unsupportedWarnings(monitor: ConfigKeyInput): ConfigKeyWarning[] {
  const out: ConfigKeyWarning[] = [];
  for (const [key, entry] of Object.entries(CONFIG_KEY_SUPPORT)) {
    if (entry.status !== 'unsupported') continue;
    const value = valueAt(monitor, key);
    if (value === undefined || value === entry.defaultValue) continue;
    out.push({
      key,
      code: 'CONFIG_KEY_UNSUPPORTED',
      message: `${key} is not supported and has no effect: ${entry.note}; remove it from the configuration`,
    });
  }
  return out;
}

function unknownWarnings(monitor: ConfigKeyInput): ConfigKeyWarning[] {
  const out: ConfigKeyWarning[] = [];
  const top = new Set(Object.keys(CONFIG_KEY_SUPPORT).filter((key) => !key.includes('.')));
  for (const key of Object.keys(monitor)) {
    if (key.startsWith('_') || top.has(key)) continue;
    out.push({
      key: shown(key),
      code: 'CONFIG_KEY_UNKNOWN',
      message: `${shown(key)} is not a known configuration key`,
    });
  }
  for (const container of CONTAINERS) {
    const value = monitor[container];
    if (!isRecord(value)) continue;
    const known = new Set(knownChildren(container));
    for (const child of Object.keys(value)) {
      if (known.has(child)) continue;
      const key = `${container}.${shown(child)}`;
      out.push({
        key,
        code: 'CONFIG_KEY_UNKNOWN',
        message: `${key} is not a known key of ${container} (known: ${[...known].join(', ')}); nothing reads it`,
      });
    }
  }
  return out;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' ? value !== '' : Array.isArray(value) ? value.length > 0 : present(value);
}

function inertWarnings(monitor: ConfigKeyInput, options: ConfigKeyOptions): ConfigKeyWarning[] {
  const out: ConfigKeyWarning[] = [];
  const explicit = (key: string): boolean => options.explicit === undefined || options.explicit.has(key);
  const panels = monitor.panels ?? {};
  const inert = (key: string, message: string): void => {
    out.push({ key, code: 'CONFIG_KEY_INERT', message });
  };
  const needsPartner = (panel: string, partner: string, isSet: boolean, why: string): void => {
    if (panels[panel] === true && !isSet) {
      inert(`panels.${panel}`, `panels.${panel} is on but ${partner} is not set, so ${why}`);
    }
  };
  needsPartner('attempts', 'attempts', present(monitor.attempts), 'the attempts panel stays empty');
  needsPartner('chain_log', 'chain_log', nonEmpty(monitor.chain_log), 'the chain log panel stays empty');
  needsPartner('ledger', 'ledger', nonEmpty(monitor.ledger), 'the ledger panel stays empty');
  if (explicit('panels.logs')) {
    needsPartner('logs', 'live_log_globs', nonEmpty(monitor.live_log_globs), 'the logs panel stays empty');
  }
  if (present(monitor.attempts) && !nonEmpty(monitor.chain_log)) {
    inert('attempts', 'attempts is set but chain_log is not, so no attempt is ever read');
  }
  if (nonEmpty(monitor.stop_file) && panels['git'] === false) {
    inert('stop_file', 'stop_file is set but panels.git is off, so the stop file is never looked at');
  }
  if (panels['machine'] === false) {
    if (monitor.docker === true && explicit('docker')) {
      inert('docker', 'docker is on but panels.machine is off, so containers are never listed');
    }
    if (nonEmpty(monitor.watched_processes) && explicit('watched_processes')) {
      inert('watched_processes', 'watched_processes is set but panels.machine is off, so no process is listed');
    }
  }
  return out;
}

/**
 * The warnings for one merged configuration: unsupported keys set away from their default, unknown keys (top level and
 * inside `panels`, `ui`, `poll`, `limits` and `attempts`, which accept any name) and keys that do nothing because the key
 * they need is missing or the panel that shows them is off.
 */
export function configKeyWarnings(monitor: ConfigKeyInput, options: ConfigKeyOptions = {}): ConfigKeyWarning[] {
  return [...unsupportedWarnings(monitor), ...unknownWarnings(monitor), ...inertWarnings(monitor, options)];
}

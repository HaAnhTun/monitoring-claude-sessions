-- mcs:migration version=1 name=initial
-- Initial schema of the per-instance monitor database (one file per monitoring instance).
-- Conventions: STRICT tables; timestamps are INTEGER epoch milliseconds UTC; booleans are INTEGER 0/1;
-- provider ids are TEXT kept verbatim; hard foreign keys only point at owners (sessions, projects, work_items);
-- every other cross-row reference is a soft integer id (no REFERENCES) validated by the repository.
-- Logical entities of docs/design/02-ingestion-lifecycle.md 4.1 map to these tables (03 section 3.5, mapping table).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) <= 4096)
) STRICT, WITHOUT ROWID;

CREATE TABLE projects (
  id               INTEGER PRIMARY KEY,
  project_key      TEXT NOT NULL UNIQUE CHECK (length(project_key) BETWEEN 1 AND 255 AND project_key = lower(project_key)),
  dir_name         TEXT NOT NULL CHECK (length(dir_name) BETWEEN 1 AND 255),
  root_path        TEXT CHECK (root_path IS NULL OR length(root_path) <= 1024),
  first_seen_at    INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id                 INTEGER PRIMARY KEY,
  session_uid        TEXT NOT NULL UNIQUE CHECK (length(session_uid) = 36 AND session_uid = lower(session_uid)),
  project_id         INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  transcript_file_id INTEGER,                          -- soft ref transcript_files(id): the main file
  label              TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  label_source       TEXT NOT NULL DEFAULT 'none'
                     CHECK (label_source IN ('rule','custom_title','ai_title','first_prompt','none')),
  matched            INTEGER NOT NULL DEFAULT 0 CHECK (matched IN (0,1)),
  rule_index         INTEGER CHECK (rule_index IS NULL OR rule_index >= 0),
  pinned             INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  title_ai           TEXT CHECK (title_ai IS NULL OR length(title_ai) <= 120),
  title_custom       TEXT CHECK (title_custom IS NULL OR length(title_custom) <= 120),
  search_text        TEXT NOT NULL DEFAULT '' CHECK (length(search_text) <= 1024),
  entrypoint         TEXT CHECK (entrypoint IS NULL OR length(entrypoint) <= 32),
  cc_version         TEXT CHECK (cc_version IS NULL OR length(cc_version) <= 32),
  cwd                TEXT CHECK (cwd IS NULL OR length(cwd) <= 1024),
  git_branch         TEXT CHECK (git_branch IS NULL OR length(git_branch) <= 255),
  permission_mode    TEXT CHECK (permission_mode IS NULL OR length(permission_mode) <= 32),
  last_model         TEXT CHECK (last_model IS NULL OR length(last_model) <= 128),
  models             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(models) AND json_type(models) = 'array' AND length(models) <= 1024),
  claude_pid         INTEGER CHECK (claude_pid IS NULL OR claude_pid > 0),
  continued_in       TEXT CHECK (continued_in IS NULL OR length(continued_in) = 36),
  copied_from        TEXT CHECK (copied_from IS NULL OR length(copied_from) = 36),
  hook_coverage      TEXT NOT NULL DEFAULT 'none' CHECK (hook_coverage IN ('none','full','partial')),
  hook_missing_tools INTEGER NOT NULL DEFAULT 0 CHECK (hook_missing_tools >= 0),
  hook_missing_turns INTEGER NOT NULL DEFAULT 0 CHECK (hook_missing_turns >= 0),
  first_seen_at      INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  last_hook_at       INTEGER,
  last_transcript_at INTEGER,
  ended_at           INTEGER,
  -- lifecycle view (02 7.1 LifecycleView); facts are the semilattice registers of 02 7.2
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  presence           TEXT NOT NULL DEFAULT 'unknown' CHECK (presence IN ('open','ended','unknown')),
  wait_reason        TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('user','permission','elicitation','agent_input','idle_prompt')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  end_reason         TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 64),
  turn_outcome       TEXT CHECK (turn_outcome IS NULL OR turn_outcome IN ('ok','error','interrupted')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 65536),
  -- counters
  agent_count        INTEGER NOT NULL DEFAULT 0 CHECK (agent_count >= 0),
  event_count        INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  tool_call_count    INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  open_tool_count    INTEGER NOT NULL DEFAULT 0 CHECK (open_tool_count >= 0),
  error_count        INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  warning_count      INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  -- usage rollup over the messages this session owns (main agent and its agents; 02 6.2 rule 7)
  usage_messages     INTEGER NOT NULL DEFAULT 0 CHECK (usage_messages >= 0),
  usage_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (usage_synthetic >= 0),
  usage_unfinalized  INTEGER NOT NULL DEFAULT 0 CHECK (usage_unfinalized >= 0),
  tok_input          INTEGER NOT NULL DEFAULT 0 CHECK (tok_input >= 0),
  tok_output         INTEGER NOT NULL DEFAULT 0 CHECK (tok_output >= 0),
  tok_cache_read     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read >= 0),
  tok_cache_creation INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation >= 0),
  tok_input_missing  INTEGER NOT NULL DEFAULT 0 CHECK (tok_input_missing >= 0),
  tok_output_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_output_missing >= 0),
  tok_cache_read_missing     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read_missing >= 0),
  tok_cache_creation_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation_missing >= 0),
  usage_status       TEXT NOT NULL DEFAULT 'none' CHECK (usage_status IN ('none','partial','complete','unavailable')),
  reported_cost_usd  REAL CHECK (reported_cost_usd IS NULL OR reported_cost_usd >= 0),
  reported_cost_at   INTEGER,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (last_activity_at >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;
CREATE INDEX idx_sessions_activity       ON sessions(last_activity_at DESC, id DESC);
CREATE INDEX idx_sessions_state_activity ON sessions(state, last_activity_at DESC);
CREATE INDEX idx_sessions_project        ON sessions(project_id, last_activity_at DESC);
CREATE INDEX idx_sessions_next_check     ON sessions(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE workflow_runs (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_uid            TEXT NOT NULL CHECK (run_uid GLOB 'wf_*' AND length(run_uid) <= 67),
  workflow_name      TEXT CHECK (workflow_name IS NULL OR length(workflow_name) <= 128),
  launch_tool_use_id TEXT CHECK (launch_tool_use_id IS NULL OR length(launch_tool_use_id) <= 128),
  status_file        TEXT CHECK (status_file IS NULL OR length(status_file) <= 32),
  agent_count        INTEGER CHECK (agent_count IS NULL OR agent_count >= 0),
  started_count      INTEGER NOT NULL DEFAULT 0 CHECK (started_count >= 0),
  result_count       INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  failed_count       INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  started_at         INTEGER,
  ended_at           INTEGER,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 16384),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (session_id, run_uid)
) STRICT;
CREATE INDEX idx_workflow_runs_next_check ON workflow_runs(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE agents (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_uid          TEXT NOT NULL CHECK (agent_uid = 'main' OR (length(agent_uid) BETWEEN 3 AND 64 AND agent_uid NOT GLOB '*[^0-9A-Za-z_-]*')),
  parent_agent_id    INTEGER,                          -- soft ref agents(id); NULL only for kind 'main'
  kind               TEXT NOT NULL CHECK (kind IN ('main','subagent','workflow_agent','teammate','internal')),
  depth              INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 16),
  agent_type         TEXT CHECK (agent_type IS NULL OR length(agent_type) <= 64),
  label              TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 160),
  description        TEXT CHECK (description IS NULL OR length(description) <= 160),
  request_shape      TEXT CHECK (request_shape IS NULL OR request_shape IN ('foreground','background')),
  spawn_tool_use_id  TEXT CHECK (spawn_tool_use_id IS NULL OR length(spawn_tool_use_id) <= 128),
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id)
  workflow_phase     TEXT CHECK (workflow_phase IS NULL OR length(workflow_phase) <= 120),
  model              TEXT CHECK (model IS NULL OR length(model) <= 128),
  transcript_file_id INTEGER,                          -- soft ref transcript_files(id)
  first_seen_at      INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  ended_at           INTEGER,
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  presence           TEXT NOT NULL DEFAULT 'unknown' CHECK (presence IN ('open','ended','unknown')),
  wait_reason        TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('user','permission','elicitation','agent_input','idle_prompt')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  end_reason         TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 64),
  turn_outcome       TEXT CHECK (turn_outcome IS NULL OR turn_outcome IN ('ok','error','interrupted')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 16384),
  tool_call_count    INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  error_count        INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  usage_messages     INTEGER NOT NULL DEFAULT 0 CHECK (usage_messages >= 0),
  usage_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (usage_synthetic >= 0),
  usage_unfinalized  INTEGER NOT NULL DEFAULT 0 CHECK (usage_unfinalized >= 0),
  tok_input          INTEGER NOT NULL DEFAULT 0 CHECK (tok_input >= 0),
  tok_output         INTEGER NOT NULL DEFAULT 0 CHECK (tok_output >= 0),
  tok_cache_read     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read >= 0),
  tok_cache_creation INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation >= 0),
  tok_input_missing  INTEGER NOT NULL DEFAULT 0 CHECK (tok_input_missing >= 0),
  tok_output_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_output_missing >= 0),
  tok_cache_read_missing     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read_missing >= 0),
  tok_cache_creation_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation_missing >= 0),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (session_id, agent_uid),
  CHECK ((kind = 'main') = (agent_uid = 'main')),
  CHECK ((kind = 'main') = (parent_agent_id IS NULL)),
  CHECK ((kind = 'main') = (depth = 0))
) STRICT;
CREATE INDEX idx_agents_state_activity ON agents(state, last_activity_at DESC) WHERE kind NOT IN ('main','internal');
CREATE INDEX idx_agents_next_check     ON agents(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE turns (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id); NULL = main agent
  prompt_id          TEXT NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 128),
  started_at         INTEGER,
  ended_at           INTEGER,
  end_kind           TEXT CHECK (end_kind IS NULL OR end_kind IN ('stop','stop_failure','end_turn','turn_duration','interrupted')),
  end_rank           INTEGER,                          -- with ended_at and end_tie: the LWW stamp of end_kind (02 4.3 Stamp)
  end_tie            TEXT CHECK (end_tie IS NULL OR length(end_tie) <= 200),
  origin             TEXT CHECK (origin IS NULL OR length(origin) <= 32),
  tool_count         INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  UNIQUE (session_id, prompt_id),
  CHECK (started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at)
) STRICT;
CREATE INDEX idx_turns_session ON turns(session_id, started_at);

CREATE TABLE transcript_files (
  id                 INTEGER PRIMARY KEY,
  path               TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  path_key           TEXT NOT NULL UNIQUE CHECK (length(path_key) BETWEEN 1 AND 1024),
  kind               TEXT NOT NULL CHECK (kind IN ('session','subagent','workflow_agent','workflow_journal','workflow_status')),
  session_uid        TEXT NOT NULL CHECK (length(session_uid) = 36),
  agent_uid          TEXT CHECK (agent_uid IS NULL OR length(agent_uid) <= 64),
  run_uid            TEXT CHECK (run_uid IS NULL OR length(run_uid) <= 67),
  session_id         INTEGER,                          -- soft ref sessions(id); NULL after cleanup (retired tombstone)
  agent_id           INTEGER,                          -- soft ref agents(id)
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id)
  -- identity and import cursors (02 5.3-5.5): 0 <= head_end <= backfill_offset <= tail_start <= tail_offset <= size_seen
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_len           INTEGER NOT NULL DEFAULT 0 CHECK (head_len BETWEEN 0 AND 256),
  head_hash          TEXT CHECK (head_hash IS NULL OR length(head_hash) = 64),
  head_end           INTEGER NOT NULL DEFAULT 0,
  backfill_offset    INTEGER NOT NULL DEFAULT 0,
  tail_start         INTEGER NOT NULL DEFAULT 0,
  tail_offset        INTEGER NOT NULL DEFAULT 0,
  partial_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (partial_bytes >= 0),
  size_seen          INTEGER NOT NULL DEFAULT 0 CHECK (size_seen >= 0),
  mtime_seen         INTEGER,
  birth_ms           INTEGER,
  first_seen_mtime_ms INTEGER,
  line_count         INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','missing','unreadable','untracked','retired')),
  usage_state        TEXT NOT NULL DEFAULT 'partial' CHECK (usage_state IN ('complete','partial','skipped_backfill')),
  invalid_json       INTEGER NOT NULL DEFAULT 0 CHECK (invalid_json >= 0),
  not_object         INTEGER NOT NULL DEFAULT 0 CHECK (not_object >= 0),
  shape_invalid      INTEGER NOT NULL DEFAULT 0 CHECK (shape_invalid >= 0),
  oversized          INTEGER NOT NULL DEFAULT 0 CHECK (oversized >= 0),
  utf8_invalid       INTEGER NOT NULL DEFAULT 0 CHECK (utf8_invalid >= 0),
  bom_stripped       INTEGER NOT NULL DEFAULT 0 CHECK (bom_stripped >= 0),
  crlf_lines         INTEGER NOT NULL DEFAULT 0 CHECK (crlf_lines >= 0),
  unknown_types      INTEGER NOT NULL DEFAULT 0 CHECK (unknown_types >= 0),
  read_errors        INTEGER NOT NULL DEFAULT 0 CHECK (read_errors >= 0),
  identity_resets    INTEGER NOT NULL DEFAULT 0 CHECK (identity_resets >= 0),
  classified_lines   INTEGER NOT NULL DEFAULT 0 CHECK (classified_lines >= 0),
  label_cache        TEXT CHECK (label_cache IS NULL OR length(label_cache) <= 200),
  first_ts_in_order  TEXT CHECK (first_ts_in_order IS NULL OR length(first_ts_in_order) <= 40),
  max_ts_string      TEXT CHECK (max_ts_string IS NULL OR length(max_ts_string) <= 40),
  last_stop_legacy   TEXT CHECK (last_stop_legacy IS NULL OR length(last_stop_legacy) <= 32),
  behind_since       INTEGER,
  discovered_at      INTEGER NOT NULL,
  last_read_at       INTEGER,
  last_growth_at     INTEGER,
  -- entry index of the transcript view (03 7.2), independent of the import cursors
  index_offset       INTEGER NOT NULL DEFAULT 0 CHECK (index_offset >= 0),
  index_head_hash    TEXT CHECK (index_head_hash IS NULL OR length(index_head_hash) = 64),
  entries_total      INTEGER NOT NULL DEFAULT 0 CHECK (entries_total >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (0 <= head_end AND head_end <= backfill_offset AND backfill_offset <= tail_start AND tail_start <= tail_offset),
  CHECK (tail_offset <= size_seen OR state <> 'active')
) STRICT;
CREATE INDEX idx_transcript_files_session ON transcript_files(session_uid);
CREATE INDEX idx_transcript_files_behind  ON transcript_files(behind_since) WHERE behind_since IS NOT NULL;

-- Sparse entry index of each transcript file: one row about every 256 display entries, always at a line start.
-- Gives stable absolute entry indexes (legacy `i`) and bounded seeks for the transcript window, locate and search.
CREATE TABLE transcript_checkpoints (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  entry_index        INTEGER NOT NULL CHECK (entry_index >= 0),
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  min_ts             INTEGER,
  max_ts             INTEGER,
  PRIMARY KEY (file_id, entry_index)
) STRICT, WITHOUT ROWID;

CREATE TABLE tool_calls (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER NOT NULL,                 -- soft ref agents(id) (the main agent row for the main conversation)
  prompt_id          TEXT CHECK (prompt_id IS NULL OR length(prompt_id) <= 128),
  tool_use_id        TEXT NOT NULL UNIQUE CHECK (length(tool_use_id) BETWEEN 1 AND 128),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mcp_server         TEXT CHECK (mcp_server IS NULL OR length(mcp_server) <= 128),
  summary            TEXT CHECK (summary IS NULL OR length(summary) <= 160),
  input_hash         TEXT CHECK (input_hash IS NULL OR length(input_hash) <= 64),
  input_bytes        INTEGER CHECK (input_bytes IS NULL OR input_bytes >= 0),
  started_at         INTEGER,
  ended_at           INTEGER,
  batch_at           INTEGER,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('ok','error','denied','interrupted')),
  exit_code          INTEGER,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  duration_source    TEXT CHECK (duration_source IS NULL OR duration_source IN ('hook','timestamps')),
  sources            INTEGER NOT NULL DEFAULT 0 CHECK (sources BETWEEN 0 AND 31),  -- 1 hook_pre, 2 hook_post, 4 transcript_use, 8 transcript_result, 16 hook_batch
  call_file_id       INTEGER,                          -- soft ref transcript_files(id)
  call_offset        INTEGER CHECK (call_offset IS NULL OR call_offset >= 0),
  result_file_id     INTEGER,
  result_offset      INTEGER CHECK (result_offset IS NULL OR result_offset >= 0),
  subagent_id        INTEGER,                          -- soft ref agents(id) (Agent tool)
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id) (Workflow tool)
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (outcome IS NULL OR ended_at IS NOT NULL)
) STRICT;
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, started_at DESC);
CREATE INDEX idx_tool_calls_name    ON tool_calls(name, started_at DESC);
CREATE INDEX idx_tool_calls_open    ON tool_calls(session_id, started_at) WHERE ended_at IS NULL AND batch_at IS NULL;

-- One timeline for hook envelopes and transcript entries (the single 02 entity `event`, from either source; N-08/C59).
-- Rows that describe the same logical event from both sources share a natural key and are merged (sources bitmask).
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id)
  kind               TEXT NOT NULL CHECK (length(kind) BETWEEN 3 AND 40 AND kind GLOB '[a-z]*.[a-z]*' AND kind NOT GLOB '*[^a-z._]*'),
  entry_kind         TEXT CHECK (entry_kind IS NULL OR entry_kind IN ('prompt','say','think','tool','result','system','attachment')),
  severity           INTEGER NOT NULL DEFAULT 0 CHECK (severity IN (0,1,2)),
  sources            INTEGER NOT NULL CHECK (sources BETWEEN 1 AND 7),      -- 1 hook, 2 transcript, 4 monitor
  ts                 INTEGER NOT NULL,
  ts_rank            INTEGER NOT NULL DEFAULT 70 CHECK (ts_rank BETWEEN 0 AND 99),
  ts_tie             TEXT NOT NULL DEFAULT '' CHECK (length(ts_tie) <= 200),
  ts_source          TEXT NOT NULL CHECK (ts_source IN ('record','hook_received','derived')),
  received_at        INTEGER NOT NULL,
  event_uid          TEXT CHECK (event_uid IS NULL OR length(event_uid) = 36),
  natural_key        TEXT CHECK (natural_key IS NULL OR length(natural_key) BETWEEN 3 AND 300),
  record_uuid        TEXT CHECK (record_uuid IS NULL OR length(record_uuid) BETWEEN 1 AND 80),
  hook_event         TEXT CHECK (hook_event IS NULL OR length(hook_event) <= 64),
  content_hash       TEXT CHECK (content_hash IS NULL OR length(content_hash) = 32),
  spool_segment      TEXT CHECK (spool_segment IS NULL OR length(spool_segment) <= 128),
  spool_offset       INTEGER CHECK (spool_offset IS NULL OR spool_offset >= 0),
  flags              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags) AND json_type(flags) = 'array' AND length(flags) <= 1024),
  prompt_id          TEXT CHECK (prompt_id IS NULL OR length(prompt_id) <= 128),
  tool_use_id        TEXT CHECK (tool_use_id IS NULL OR length(tool_use_id) <= 128),
  tool_name          TEXT CHECK (tool_name IS NULL OR length(tool_name) <= 200),
  message_id         TEXT CHECK (message_id IS NULL OR length(message_id) <= 128),
  file_id            INTEGER,                          -- soft ref transcript_files(id)
  byte_offset        INTEGER CHECK (byte_offset IS NULL OR byte_offset >= 0),
  byte_length        INTEGER CHECK (byte_length IS NULL OR byte_length > 0),
  line_no            INTEGER CHECK (line_no IS NULL OR line_no >= 0),
  record_type        TEXT CHECK (record_type IS NULL OR length(record_type) <= 32),
  subtype            TEXT CHECK (subtype IS NULL OR length(subtype) <= 40),
  text_len           INTEGER CHECK (text_len IS NULL OR text_len >= 0),
  summary            TEXT CHECK (summary IS NULL OR length(summary) <= 240),
  detail             TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 16384)),
  change_seq         INTEGER NOT NULL DEFAULT 0 CHECK (change_seq >= 0),
  CHECK (event_uid IS NOT NULL OR natural_key IS NOT NULL OR record_uuid IS NOT NULL),
  CHECK ((file_id IS NULL) = (byte_offset IS NULL))
) STRICT;
CREATE UNIQUE INDEX ux_events_event_uid   ON events(event_uid)   WHERE event_uid IS NOT NULL;
CREATE UNIQUE INDEX ux_events_natural_key ON events(natural_key) WHERE natural_key IS NOT NULL;
CREATE UNIQUE INDEX ux_events_record_uuid ON events(record_uuid) WHERE record_uuid IS NOT NULL;
CREATE INDEX idx_events_session_ts ON events(session_id, ts DESC, id DESC);
CREATE INDEX idx_events_ts         ON events(ts DESC, id DESC);
CREATE INDEX idx_events_kind_ts    ON events(kind, ts DESC, id DESC);
CREATE INDEX idx_events_problems   ON events(ts DESC, id DESC) WHERE severity > 0;
CREATE INDEX idx_events_content    ON events(session_id, hook_event, content_hash, received_at) WHERE content_hash IS NOT NULL;

-- Second and later occurrences of a transcript record (resume copies, 02 D-4).
CREATE TABLE entry_occurrences (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  record_uuid        TEXT NOT NULL CHECK (length(record_uuid) BETWEEN 1 AND 80),
  PRIMARY KEY (file_id, byte_offset)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_entry_occurrences_uuid ON entry_occurrences(record_uuid);

-- Per-file usage per message key (02 6.2 rules 1-5, 11): NULL = missing value; legacy_* = top-level integers for parity.
CREATE TABLE usage_files (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  message_key        TEXT NOT NULL CHECK (length(message_key) BETWEEN 1 AND 160),
  model              TEXT CHECK (model IS NULL OR length(model) <= 128),
  input_tokens       INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens  INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  thinking_tokens    INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  web_search_requests INTEGER CHECK (web_search_requests IS NULL OR web_search_requests >= 0),
  web_fetch_requests  INTEGER CHECK (web_fetch_requests IS NULL OR web_fetch_requests >= 0),
  legacy_in          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_in >= 0),
  legacy_out         INTEGER NOT NULL DEFAULT 0 CHECK (legacy_out >= 0),
  legacy_cr          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_cr >= 0),
  legacy_cc          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_cc >= 0),
  finalized          INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0,1)),
  usage_source       TEXT NOT NULL DEFAULT 'top' CHECK (usage_source IN ('top','iterations')),
  synthetic          INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  first_ts           INTEGER,
  last_ts            INTEGER,
  record_count       INTEGER NOT NULL DEFAULT 1 CHECK (record_count >= 1),
  invalid_values     INTEGER NOT NULL DEFAULT 0 CHECK (invalid_values >= 0),
  PRIMARY KEY (file_id, message_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_usage_files_key ON usage_files(message_key);

-- Instance-wide value of each message key (02 6.2 rules 6-7): per-field max over its usage_files rows, owner = oldest file.
CREATE TABLE usage (
  id                 INTEGER PRIMARY KEY,
  message_key        TEXT NOT NULL UNIQUE CHECK (length(message_key) BETWEEN 1 AND 160),
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,   -- owner session
  agent_id           INTEGER NOT NULL,                 -- soft ref agents(id): owner agent (main agent row for a main file)
  owner_file_id      INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  model              TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  ts                 INTEGER NOT NULL,                 -- earliest first_ts over the files (bucketing time)
  input_tokens       INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens  INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  thinking_tokens    INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  web_search_requests INTEGER CHECK (web_search_requests IS NULL OR web_search_requests >= 0),
  web_fetch_requests  INTEGER CHECK (web_fetch_requests IS NULL OR web_fetch_requests >= 0),
  finalized          INTEGER NOT NULL CHECK (finalized IN (0,1)),
  usage_source       TEXT NOT NULL CHECK (usage_source IN ('top','iterations')),
  synthetic          INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  files              INTEGER NOT NULL DEFAULT 1 CHECK (files >= 1),
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_usage_session  ON usage(session_id);
-- Covering index for every time-window aggregate; analytics queries name it with INDEXED BY (03 3.7 rule 1).
CREATE INDEX idx_usage_ts_cover ON usage(ts, model, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, finalized, synthetic);

-- Provider-reported cumulative cost per file (02 6.6); never summed with transcript tokens.
CREATE TABLE cost_states (
  file_id            INTEGER PRIMARY KEY,              -- soft ref transcript_files(id)
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  total_cost_usd     REAL CHECK (total_cost_usd IS NULL OR total_cost_usd >= 0),
  model_usage_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_usage_json) AND length(model_usage_json) <= 8192),
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  is_trailing        INTEGER NOT NULL DEFAULT 0 CHECK (is_trailing IN (0,1)),
  observed_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_cost_states_session ON cost_states(session_id);

CREATE TABLE state_transitions (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id); NULL = session level
  from_state         TEXT,
  to_state           TEXT NOT NULL,
  rule               TEXT NOT NULL CHECK (length(rule) BETWEEN 1 AND 16),
  basis              TEXT NOT NULL CHECK (basis IN ('observed','inferred')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  evidence           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND length(evidence) <= 4096),
  at                 INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_transitions_session ON state_transitions(session_id, at DESC);

-- Append-only reconciliation records (02 8.1); ids and numbers only.
CREATE TABLE reconciliations (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER REFERENCES sessions(id) ON DELETE CASCADE,       -- NULL = instance level
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 64), -- session uid or 'instance'
  kind               TEXT NOT NULL CHECK (kind IN ('activity_after_end','hook_gap','runtime_unavailable','identity_reset','copied_records','handler_failing')),
  at                 INTEGER NOT NULL,
  detail             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 2048),
  detail_hash        TEXT NOT NULL CHECK (length(detail_hash) = 32),
  UNIQUE (scope_key, kind, detail_hash)
) STRICT;
CREATE INDEX idx_reconciliations_session ON reconciliations(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_reconciliations_kind_at ON reconciliations(kind, at DESC);

-- Latest external observation per session and source (02 7.10).
CREATE TABLE external_observations (
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source             TEXT NOT NULL CHECK (source IN ('registry','job','pid','attempt')),
  observed_at        INTEGER NOT NULL,
  value_json         TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 2048),
  PRIMARY KEY (session_id, source)
) STRICT, WITHOUT ROWID;

CREATE TABLE hook_probes (
  probe_session_id   TEXT PRIMARY KEY NOT NULL CHECK (length(probe_session_id) = 36),
  received_at        INTEGER NOT NULL,
  committed_at       INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE work_items (
  id                 INTEGER PRIMARY KEY,
  item_key           TEXT NOT NULL UNIQUE CHECK (length(item_key) BETWEEN 3 AND 200),  -- 'attempt:<part>' | 'label:<label>' | declared key
  kind               TEXT NOT NULL CHECK (kind IN ('declared','attempt','label')),
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  state              TEXT NOT NULL CHECK (state IN ('working','waiting','completed','failed','stale','unknown')),
  rule               TEXT NOT NULL CHECK (rule IN ('W-DECL','W-ATT','W-LBL')),
  board_reason       TEXT NOT NULL CHECK (length(board_reason) BETWEEN 1 AND 16),   -- order row of the board-state table (02 7.11)
  evidence           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND length(evidence) <= 8192),
  state_since        INTEGER NOT NULL,
  session_count      INTEGER NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  last_activity_at   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_work_items_state ON work_items(state, last_activity_at DESC);

CREATE TABLE work_item_sessions (
  work_item_id       INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  session_id         INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,   -- a session belongs to at most one item
  linked_at          INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, session_id)
) STRICT, WITHOUT ROWID;

-- Instance ingestion health (02 8.2): one row, the last computed report plus durable counters.
CREATE TABLE ingest_health (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  evaluated_at       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ok','degraded','down')),
  last_envelope_at   INTEGER,
  last_commit_at     INTEGER,
  last_drain_at      INTEGER,
  last_nudge_at      INTEGER,
  last_scan_at       INTEGER,
  last_sync_at       INTEGER,
  counters_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counters_json) AND length(counters_json) <= 16384),
  report_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(report_json) AND length(report_json) <= 65536),
  updated_at         INTEGER NOT NULL
) STRICT;

-- One row per ingest error occurrence (02 4.8); retention keeps the newest 1000.
CREATE TABLE ingest_errors (
  id                 INTEGER PRIMARY KEY,
  at                 INTEGER NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('spool','transcript','external','writer','handler','alerts','db')),
  code               TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code = upper(code)),
  file_id            INTEGER,                          -- soft ref transcript_files(id)
  segment            TEXT CHECK (segment IS NULL OR length(segment) <= 128),
  byte_offset        INTEGER CHECK (byte_offset IS NULL OR byte_offset >= 0),
  session_uid        TEXT CHECK (session_uid IS NULL OR length(session_uid) = 36),
  detail             TEXT CHECK (detail IS NULL OR length(detail) <= 200)
) STRICT;
CREATE INDEX idx_ingest_errors_at   ON ingest_errors(at DESC);
CREATE INDEX idx_ingest_errors_code ON ingest_errors(code, at DESC);

-- Spool segment cursors (02 2.7, `spool_cursor`).
CREATE TABLE spool_cursors (
  segment            TEXT PRIMARY KEY NOT NULL
                     CHECK (length(segment) BETWEEN 7 AND 128 AND segment GLOB '*.ndjson' AND segment NOT GLOB '*[/\:]*'),
  offset_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
  size_seen          INTEGER NOT NULL DEFAULT 0 CHECK (size_seen >= 0),
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_hash          TEXT CHECK (head_hash IS NULL OR length(head_hash) = 64),
  lines              INTEGER NOT NULL DEFAULT 0 CHECK (lines >= 0),
  partial_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (partial_bytes >= 0),
  sealed             INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
  errors             INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0),
  oldest_received_at INTEGER,
  newest_received_at INTEGER,
  first_seen_at      INTEGER NOT NULL,
  drained_at         INTEGER,
  updated_at         INTEGER NOT NULL,
  CHECK (offset_bytes <= size_seen)
) STRICT, WITHOUT ROWID;

-- Chain-log attempts (06 3.10): one row per configured chain-log file, one row per START line of that file.
CREATE TABLE attempt_sources (
  id                 INTEGER PRIMARY KEY,
  path               TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),          -- canonicalPath of chain_log (06 4.1)
  path_key           TEXT NOT NULL UNIQUE CHECK (length(path_key) BETWEEN 1 AND 1024),  -- pathKey(path): samePath comparison key
  generation         INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),             -- +1 when the file was truncated or replaced
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_len           INTEGER NOT NULL CHECK (head_len BETWEEN 0 AND 256),
  head_hash          TEXT NOT NULL CHECK (length(head_hash) = 64),                   -- sha256 hex of the first head_len bytes
  read_offset        INTEGER NOT NULL DEFAULT 0 CHECK (read_offset >= 0),            -- byte offset after the last consumed LF
  config_sha256      TEXT NOT NULL CHECK (length(config_sha256) = 64),               -- hash of {start, end, label_prefix, time_format}
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE attempt_runs (
  id                 INTEGER PRIMARY KEY,
  source_id          INTEGER NOT NULL,                 -- soft ref attempt_sources(id)
  generation         INTEGER NOT NULL CHECK (generation >= 1),
  start_offset       INTEGER NOT NULL CHECK (start_offset >= 0),                     -- byte offset of the START line (natural key)
  part               TEXT NOT NULL CHECK (length(part) <= 512),                      -- '' when the group is absent (legacy)
  n_raw              TEXT CHECK (n_raw IS NULL OR length(n_raw) <= 64),
  model              TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),  -- NULL when absent or empty
  effort             TEXT CHECK (effort IS NULL OR length(effort) BETWEEN 1 AND 64),
  started_at         INTEGER NOT NULL,
  end_offset         INTEGER CHECK (end_offset IS NULL OR end_offset > start_offset),
  ended_at           INTEGER,                          -- = started_at when the END time does not parse (legacy)
  exit_raw           TEXT CHECK (exit_raw IS NULL OR length(exit_raw) <= 64),
  status_raw         TEXT CHECK (status_raw IS NULL OR length(status_raw) <= 512),
  end_reason         TEXT NOT NULL DEFAULT 'open' CHECK (end_reason IN ('open','ended','superseded')),
  state              TEXT NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('COMPLETED','FAILED','RUNNING','UNKNOWN')),
  evidence           TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 1024),
  session_id         INTEGER,                          -- soft ref sessions(id); NULL = not matched
  match_delta_ms     INTEGER,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (source_id, generation, start_offset),
  CHECK ((end_reason = 'open') = (state = 'RUNNING')),
  CHECK ((end_reason = 'ended') = (ended_at IS NOT NULL AND end_offset IS NOT NULL)),
  CHECK (match_delta_ms IS NULL OR session_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_attempt_runs_session ON attempt_runs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_attempt_runs_open    ON attempt_runs(source_id, generation, part) WHERE end_reason = 'open';
CREATE INDEX idx_attempt_runs_start   ON attempt_runs(started_at, id);

CREATE TABLE alerts (
  id                 INTEGER PRIMARY KEY,
  rule_id            TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  rule_kind          TEXT NOT NULL CHECK (rule_kind IN
                     ('inactivity','ingest_errors','runtime_unavailable','token_threshold','import_lag','db_disk','hook_gap','hook_failing')),
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('instance','session','code')),
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
  session_id         INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  severity           TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 2048),
  first_fired_at     INTEGER NOT NULL,
  last_fired_at      INTEGER NOT NULL,
  fire_count         INTEGER NOT NULL DEFAULT 1 CHECK (fire_count >= 1),
  resolved_at        INTEGER,
  resolved_reason    TEXT CHECK (resolved_reason IS NULL OR resolved_reason IN ('condition_cleared','expired','rule_disabled','scope_deleted')),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (last_fired_at >= first_fired_at)
) STRICT;
CREATE UNIQUE INDEX ux_alerts_live    ON alerts(rule_id, scope_key) WHERE status = 'open';
CREATE INDEX idx_alerts_status        ON alerts(status, last_fired_at DESC);
CREATE INDEX idx_alerts_session       ON alerts(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE alert_state (
  rule_id            TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
  condition_since    INTEGER,
  last_value         REAL,
  last_evaluated_at  INTEGER NOT NULL,
  cooldown_until     INTEGER,
  PRIMARY KEY (rule_id, scope_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE changes (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                 INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('session','agent','workflow','tool_call','event','transcript','work_item','usage','alert','health','attempt')),
  op                 TEXT NOT NULL CHECK (op IN ('upsert','delete','append','invalidate')),
  session_uid        TEXT CHECK (session_uid IS NULL OR length(session_uid) = 36),
  entity_id          INTEGER,
  payload            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND length(payload) <= 2048),
  CHECK (kind || '/' || op IN ('session/upsert','session/delete','agent/upsert','workflow/upsert','tool_call/upsert','event/append',
         'transcript/append','work_item/upsert','usage/invalidate','alert/upsert','health/upsert','attempt/upsert'))
) STRICT;
CREATE INDEX idx_changes_at ON changes(at);

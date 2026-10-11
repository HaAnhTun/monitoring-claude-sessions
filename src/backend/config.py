"""Configuration: shared defaults, task overrides, deterministic merge, validation, provenance.

Single source of truth for defaults is config/defaults.json. A task's config.json (or a legacy flat --config file)
overrides single keys; dict-valued keys merge key by key, everything else replaces.
"""
import copy, json, os, re

SUPPORTED_SCHEMAS = (1,)
SKILL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEFAULTS_PATH = os.path.join(SKILL_DIR, 'config', 'defaults.json')
MERGED_DICTS = ('panels', 'ui', 'poll', 'limits')
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,47}$')


class ConfigError(Exception):
    pass


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _opt_str(v):
    return v is None or isinstance(v, str)


def _str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _rules(v):
    return isinstance(v, list) and all(isinstance(r, dict) and isinstance(r.get('match'), str) for r in v)


def _bool_dict(v):
    return isinstance(v, dict) and all(isinstance(x, bool) for x in v.values())


def _num_dict(v):
    return isinstance(v, dict) and all(_is_num(x) for x in v.values())


def _ui(v):
    return (isinstance(v, dict) and v.get('theme', 'auto') in ('auto', 'light', 'dark')
            and v.get('density', 'comfortable') in ('comfortable', 'compact')
            and all(isinstance(x, bool) for k, x in v.items() if k not in ('theme', 'density')))


def _attempts(v):
    return v is None or (isinstance(v, dict) and isinstance(v.get('start'), str) and isinstance(v.get('end'), str))


# key -> (validator, expected, merge-kind)
SCHEMA = {
    'schema_version': (_is_int, 'integer'),
    'title': (lambda v: isinstance(v, str) and bool(v.strip()), 'non-empty string'),
    'port': (lambda v: _is_int(v) and 1 <= v <= 65535, 'integer 1-65535'),
    'repo': (lambda v: isinstance(v, str), 'string path'),
    'transcripts_dir': (lambda v: isinstance(v, str) or v is None, "'auto' or a path"),
    'window_hours': (lambda v: _is_num(v) and v > 0, 'positive number'),
    'active_seconds': (lambda v: _is_num(v) and v > 0, 'positive number'),
    'pending_tool_grace_seconds': (lambda v: _is_num(v) and v > 0, 'positive number'),
    'include_unmatched': (lambda v: isinstance(v, bool), 'boolean'),
    'session_rules': (_rules, 'list of {match, label, scope?}'),
    'session_ids': (_str_list, 'list of session id strings'),
    'panels': (_bool_dict, 'object of booleans'),
    'live_log_globs': (_str_list, 'list of strings'),
    'chain_log': (_opt_str, 'string or null'),
    'ledger': (_opt_str, 'string or null'),
    'stop_file': (_opt_str, 'string or null'),
    'attempts': (_attempts, 'null or {start, end, ...}'),
    'watched_processes': (_str_list, 'list of strings'),
    'docker': (lambda v: isinstance(v, bool), 'boolean'),
    'ui': (_ui, 'object: theme auto|light|dark, density comfortable|compact, booleans'),
    'poll': (_num_dict, 'object of numbers (milliseconds)'),
    'limits': (_num_dict, 'object of numbers'),
}


def load_defaults():
    try:
        with open(DEFAULTS_PATH, encoding='utf-8') as f:
            return {k: v for k, v in json.load(f).items() if not k.startswith('_')}
    except (OSError, ValueError) as e:
        raise ConfigError('cannot read shared defaults %s: %s' % (DEFAULTS_PATH, e))


def validate(cfg, strict=True):
    """Problems with a (partial or full) config dict; empty list when valid. strict rejects unknown keys."""
    problems = []
    if not isinstance(cfg, dict):
        return ['config must be a JSON object']
    for k, v in cfg.items():
        if k.startswith('_'):
            continue
        if k not in SCHEMA:
            if strict:
                problems.append('unknown key %r' % k)
            continue
        ok, expected = SCHEMA[k]
        if not ok(v):
            problems.append('%s: expected %s, got %s' % (k, expected, json.dumps(v)[:60]))
    for r in cfg.get('session_rules') or []:
        try:
            re.compile(r.get('match', ''))
        except (re.error, AttributeError) as e:
            problems.append('session_rules: invalid regex %r (%s)' % (r.get('match') if isinstance(r, dict) else r, e))
    a = cfg.get('attempts')
    if isinstance(a, dict):
        for k in ('start', 'end'):
            try:
                re.compile(a.get(k, ''))
            except (re.error, TypeError) as e:
                problems.append('attempts.%s: invalid regex (%s)' % (k, e))
    return problems


def check_schema_version(cfg, where):
    v = cfg.get('schema_version')
    if v is None:
        raise ConfigError('%s has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against docs/configuration.md)' % where)
    if v not in SUPPORTED_SCHEMAS:
        raise ConfigError('%s uses schema_version %s but this skill supports %s; update the skill or migrate the file explicitly' % (where, v, list(SUPPORTED_SCHEMAS)))


def merge(base, over):
    """Deterministic merge: dict-valued keys in MERGED_DICTS merge per key, everything else is replaced."""
    out = copy.deepcopy(base)
    for k, v in over.items():
        if k.startswith('_'):
            continue
        if k in MERGED_DICTS and isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(copy.deepcopy(v))
        else:
            out[k] = copy.deepcopy(v)
    return out


def provenance(defaults, over, source):
    """Where each effective value comes from: 'default' or the override source name ('task' or 'legacy')."""
    prov = {}
    for k, v in defaults.items():
        if k in MERGED_DICTS and isinstance(v, dict):
            for sk in v:
                prov['%s.%s' % (k, sk)] = source if sk in (over.get(k) or {}) else 'default'
        else:
            prov[k] = source if k in over else 'default'
    for k in over:
        if not k.startswith('_') and k not in defaults:
            prov[k] = source
    return prov


def slugify(name):
    s = re.sub(r'[^a-z0-9]+', '-', (name or '').lower()).strip('-')[:48].strip('-')
    return s or 'task'


def check_slug(slug):
    if not isinstance(slug, str) or not SLUG_RE.match(slug) or slug in ('con', 'nul', 'prn', 'aux'):
        raise ConfigError('invalid task slug %r (use lowercase letters, digits and hyphens, at most 48 characters)' % (slug,))
    return slug


def resolve_runtime(config_path=None, task_dir=None):
    """Build the effective runtime config. Exactly one of config_path (legacy flat file) or task_dir, or neither (defaults).
    Returns (cfg, meta) where meta = {source, provenance, task, problems, path}."""
    defaults = load_defaults()
    over, source, task, path = {}, 'defaults', None, None
    if task_dir:
        path = os.path.join(task_dir, 'config.json')
        task = read_json(os.path.join(task_dir, 'task.json'))
        over = read_json(path)
        check_schema_version(over, path)
        source = 'task'
    elif config_path:
        path = os.path.abspath(config_path)
        over = read_json(path)
        source = 'legacy'
        if 'schema_version' in over:
            check_schema_version(over, path)
    problems = validate(over, strict=(source == 'task'))
    if problems and source == 'task':
        raise ConfigError('invalid task config %s: %s' % (path, '; '.join(problems)))
    cfg = merge(defaults, over)
    base = task_dir if task_dir else (os.path.dirname(path) if path else os.getcwd())
    repo = cfg['repo']
    if task_dir and 'repo' not in over and task.get('repo'):
        repo = task['repo']
    cfg['repo'] = os.path.abspath(repo if os.path.isabs(repo) else os.path.join(base, repo))
    cfg['_source_path'] = path
    return cfg, {'source': source, 'provenance': provenance(defaults, over, source), 'task': task, 'problems': problems, 'path': path}


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except OSError as e:
        raise ConfigError('cannot read %s: %s' % (path, e))
    except ValueError as e:
        raise ConfigError('%s is not valid JSON: %s' % (path, e))
    if not isinstance(data, dict):
        raise ConfigError('%s must contain a JSON object' % path)
    return data


def write_json_atomic(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)

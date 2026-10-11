"""Per-task monitoring workspaces under <repo>/.claude/monitor/tasks/<slug>/.

    task.json      identity (id, name, description, created, repo, schema_version)
    config.json    task overrides only (shared defaults live in config/defaults.json)
    state.json     runtime only (pid, url, port, started); exists while a monitor runs
    audit/changes.md, audit/decisions.md    append-only records

Rules: stable slug; reuse instead of duplicate; never touch another task; every persistent change is audited;
destructive actions need an explicit flag; no raw transcript content is ever copied here.
"""
import datetime, hashlib, json, os, re

from . import config as C

TASK_SCHEMA = 1


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def tasks_root(repo):
    return os.path.join(os.path.abspath(repo), '.claude', 'monitor', 'tasks')


def task_dir(root, slug):
    """Directory of a task; the slug is validated and the result must stay inside root."""
    C.check_slug(slug)
    d = os.path.join(root, slug)
    if os.path.commonpath([os.path.realpath(root), os.path.realpath(d)]) != os.path.realpath(root):
        raise C.ConfigError('task path escapes the tasks root')
    return d


def list_tasks(root):
    out = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            if C.SLUG_RE.match(name) and os.path.isfile(os.path.join(root, name, 'task.json')):
                out.append(name)
    return out


def _append(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with open(path, 'a', encoding='utf-8', newline='\n') as f:
        if new:
            f.write('# %s\n\n' % ('Changes' if path.endswith('changes.md') else 'Decisions'))
        f.write(text)


def audit_change(d, action, summary, reason, files, validation, outcome, unresolved='none'):
    _append(os.path.join(d, 'audit', 'changes.md'),
            '## %s | %s\n- Summary: %s\n- Reason: %s\n- Files changed: %s\n- Validation: %s\n- Outcome: %s\n- Unresolved: %s\n\n' % (
                now_iso(), action, summary, reason or 'not given', ', '.join(files) or 'none', validation, outcome, unresolved))


def record_decision(d, title, decision, rejected=''):
    _append(os.path.join(d, 'audit', 'decisions.md'),
            '## %s | %s\n- Decision: %s\n- Rejected alternatives: %s\n\n' % (now_iso(), title, decision, rejected or 'none recorded'))


def last_change(d):
    p = os.path.join(d, 'audit', 'changes.md')
    try:
        with open(p, encoding='utf-8') as f:
            text = f.read()
    except OSError:
        return None
    blocks = re.split(r'(?m)^## ', text)[1:]
    if not blocks:
        return None
    head, _, rest = blocks[-1].partition('\n')
    m = re.search(r'- Summary: (.*)', rest)
    return {'t': head.split(' | ')[0].strip(), 'summary': m.group(1).strip() if m else head}


def init_task(root, repo, name, slug=None, description=''):
    """Create the workspace, or reuse it when it already exists (nothing is overwritten). Returns (dir, created)."""
    slug = C.check_slug(slug or C.slugify(name))
    d = task_dir(root, slug)
    if os.path.isfile(os.path.join(d, 'task.json')):
        return d, False
    os.makedirs(os.path.join(d, 'audit'), exist_ok=True)
    relrepo = os.path.relpath(os.path.abspath(repo), d).replace('\\', '/')
    C.write_json_atomic(os.path.join(d, 'task.json'), {
        'schema_version': TASK_SCHEMA, 'id': slug, 'name': name or slug, 'description': description or '', 'created': now_iso(),
        'repo': relrepo, 'links': []})
    C.write_json_atomic(os.path.join(d, 'config.json'), {'schema_version': 1, 'title': name or slug})
    with open(os.path.join(d, 'README.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('# Monitoring task: %s\n\n%s\n\n- `task.json` identity, `config.json` overrides of the shared defaults, `audit/` change and decision log.\n'
                '- Inspect: `python <skill>/template/viewer.py inspect --task %s`\n- Never copy transcripts here; they are read in place.\n' % (name or slug, description or '', slug))
    audit_change(d, 'init-task', 'created task workspace %r' % slug, 'monitoring requested for this task', ['task.json', 'config.json', 'README.md'],
                 'schema ok', 'created')
    return d, True


def _get_path(d, dotted):
    cur = d
    for part in dotted.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _set_path(d, dotted, value):
    parts = dotted.split('.')
    for p in parts[:-1]:
        d = d.setdefault(p, {})
        if not isinstance(d, dict):
            raise C.ConfigError('cannot set %s: %s is not an object' % (dotted, p))
    d[parts[-1]] = value


def _del_path(d, dotted):
    parts = dotted.split('.')
    for p in parts[:-1]:
        d = d.get(p)
        if not isinstance(d, dict):
            return False
    return d.pop(parts[-1], None) is not None


def _short(v):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= 120 else s[:117] + '...'


def configure(d, sets=None, unsets=None, reason='', decision=''):
    """Apply validated changes to the task's config.json (existing content is read first and preserved) and audit them.
    Returns a report dict. Unchanged input writes nothing and audits nothing."""
    path = os.path.join(d, 'config.json')
    cur = C.read_json(path)
    C.check_schema_version(cur, path)
    new = json.loads(json.dumps(cur))
    defaults = C.load_defaults()
    changes = []

    def was(k):
        v = _get_path(new, k)
        return _short(v) if v is not None else '(default %s)' % _short(_get_path(defaults, k))

    for k, v in (sets or {}).items():
        if k.split('.')[0] == 'schema_version':
            raise C.ConfigError('schema_version cannot be changed with configure')
        before = was(k)
        if _get_path(new, k) != v:
            _set_path(new, k, v)
            changes.append('%s: %s -> %s' % (k, before, _short(v)))
    for k in unsets or []:
        if k.split('.')[0] in ('schema_version',):
            raise C.ConfigError('schema_version cannot be removed')
        before = was(k)
        if _del_path(new, k):
            changes.append('%s: %s -> (removed, default applies)' % (k, before))
    problems = C.validate(new, strict=True)
    if problems:
        raise C.ConfigError('rejected, nothing written: ' + '; '.join(problems))
    if not changes:
        return {'changed': False, 'changes': [], 'unchanged': sorted(k for k in cur if not k.startswith('_'))}
    C.write_json_atomic(path, new)
    audit_change(d, 'configure', '; '.join(changes), reason, ['config.json'], 'schema ok (strict)', 'applied')
    if decision:
        record_decision(d, 'configuration', decision)
    return {'changed': True, 'changes': changes, 'unchanged': sorted(k for k in new if k not in {c.split(':')[0].split('.')[0] for c in changes})}


def inspect(root, slug):
    """Everything an agent needs to know about a task without starting the monitor."""
    d = task_dir(root, slug)
    task = C.read_json(os.path.join(d, 'task.json'))
    cfg, meta = C.resolve_runtime(task_dir=d)
    st = read_state(d)
    return {'task': task, 'dir': d, 'effective': {k: v for k, v in cfg.items() if not k.startswith('_')}, 'provenance': meta['provenance'],
            'runtime': st, 'last_change': last_change(d), 'config_hash': hashlib.sha1(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:12]}


def read_state(d):
    try:
        return C.read_json(os.path.join(d, 'state.json'))
    except C.ConfigError:
        return None


def audit_tasks(root, slugs=None):
    """Static checks per task: files present, ids match, schema valid, nothing escaping the task directory."""
    report = []
    for slug in slugs or list_tasks(root):
        probs = []
        try:
            d = task_dir(root, slug)
            task = C.read_json(os.path.join(d, 'task.json'))
            if task.get('id') != slug:
                probs.append('task.json id %r does not match folder %r' % (task.get('id'), slug))
            if task.get('schema_version') != TASK_SCHEMA:
                probs.append('task.json schema_version %r unsupported' % task.get('schema_version'))
            try:
                C.resolve_runtime(task_dir=d)
            except C.ConfigError as e:
                probs.append(str(e))
            if not os.path.isfile(os.path.join(d, 'audit', 'changes.md')):
                probs.append('audit/changes.md missing')
            for dirpath, dirs, files in os.walk(d):
                for n in dirs + files:
                    p = os.path.join(dirpath, n)
                    if os.path.islink(p):
                        probs.append('symlink inside task workspace: %s' % os.path.relpath(p, d))
                    elif n.endswith('.jsonl'):
                        probs.append('transcript copy found (never copy transcripts): %s' % os.path.relpath(p, d))
        except C.ConfigError as e:
            probs.append(str(e))
        report.append({'task': slug, 'ok': not probs, 'problems': probs})
    return report


def snapshot(root, exclude=None):
    """Hash of every task's files, for isolation checks: changing one task must not change another."""
    out = {}
    for slug in list_tasks(root):
        if slug == exclude:
            continue
        h = hashlib.sha1()
        for dirpath, _, files in sorted(os.walk(os.path.join(root, slug))):
            for n in sorted(files):
                p = os.path.join(dirpath, n)
                if n == 'state.json':
                    continue
                with open(p, 'rb') as f:
                    h.update(p.encode() + f.read())
        out[slug] = h.hexdigest()
    return out

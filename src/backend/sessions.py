"""Session discovery, classification, subagent mapping and the session list."""
import datetime, glob, json, os, re, time

from . import state as st

SID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
AGENT_RE = re.compile(r'^[0-9A-Za-z_-]{3,64}$')
BOILER = re.compile(r'^\s*<(local-command|ide_|browser_instruction|system-reminder|command-|user-prompt)')


def projects_root():
    return os.path.join(st.claude_home(), 'projects')


def first_cwd(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 60:
                    break
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get('cwd'):
                    return r['cwd']
    except OSError:
        pass
    return ''


def detect_transcripts_dir(repo):
    """Find the Claude Code project folder of a repository: guess the sanitized name, else match the recorded cwd."""
    root = projects_root()
    if not os.path.isdir(root):
        return None
    san = re.sub(r'[^A-Za-z0-9]', '-', repo)
    for cand in (san, san.lower()):
        if os.path.isdir(os.path.join(root, cand)):
            return os.path.join(root, cand)
    want = os.path.normcase(os.path.normpath(repo))
    for d in sorted(glob.glob(os.path.join(root, '*')), key=os.path.getmtime, reverse=True):
        files = sorted(glob.glob(os.path.join(d, '*.jsonl')), key=os.path.getmtime, reverse=True)[:3]
        for f in files:
            if os.path.normcase(os.path.normpath(first_cwd(f))) == want:
                return d
    return None


def _blocks(r):
    c = (r.get('message') or {}).get('content') if isinstance(r.get('message'), dict) else None
    return [c] if isinstance(c, str) else [b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text']


def user_texts(path, limit=25):
    """First real user text blocks (harness boilerplate such as IDE notes and local-command caveats is skipped)."""
    out = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 400 or len(out) >= limit:
                    break
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get('type') == 'user':
                    out.extend(x for x in _blocks(r) if isinstance(x, str) and x and not BOILER.match(x))
    except OSError:
        pass
    return out


def first_user_text(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i > 120:
                    break
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get('type') == 'user':
                    for x in _blocks(r):
                        if isinstance(x, str) and x:
                            return x
    except OSError:
        pass
    return ''


def real_first_prompt(path):
    t = user_texts(path, 1)
    return t[0] if t else first_user_text(path)


def classify(cfg, path):
    """(label, matched). The first matching rule wins; a rule matches the first real prompt, or with "scope": "any"
    any of the first 25 real prompts."""
    head, anyp = real_first_prompt(path), None
    for rule in cfg['session_rules']:
        text = head
        if rule.get('scope') == 'any':
            if anyp is None:
                anyp = '\n'.join(user_texts(path))
            text = anyp
        try:
            m = re.search(rule['match'], text, re.S)
        except re.error:
            continue
        if m:
            label = rule.get('label', rule.get('name', 'session'))
            for i, g in enumerate(m.groups() or (), start=1):
                label = label.replace('{%d}' % i, g or '')
            return label.replace('{0}', m.group(0)[:40]), True
    return (head.strip().replace('\n', ' ')[:70] or '(no prompt)'), False


def epoch(iso):
    try:
        return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()
    except Exception:
        return 0


def agent_files(tdir, sid):
    base = os.path.join(tdir, sid)
    out = []
    for p in glob.glob(os.path.join(base, 'subagents', '**', 'agent-*.jsonl'), recursive=True):
        aid = os.path.basename(p)[len('agent-'):-len('.jsonl')]
        meta = {}
        try:
            with open(p[:-len('.jsonl')] + '.meta.json', encoding='utf-8') as f:
                meta = json.load(f)
        except (OSError, ValueError):
            pass
        wf = os.path.basename(os.path.dirname(p)) if 'workflows' in p else ''
        wf_name = ''
        if wf:
            try:
                with open(os.path.join(base, 'workflows', wf + '.json'), encoding='utf-8') as f:
                    wf_name = json.load(f).get('workflowName', '')
            except (OSError, ValueError, AttributeError):
                pass
        label = next((meta[k] for k in ('label', 'description', 'name', 'agentType') if isinstance(meta.get(k), str) and meta[k]), '')
        out.append({'agent': aid, 'path': p, 'label': label or aid, 'model': meta.get('model') if isinstance(meta.get('model'), str) else '', 'workflow': wf_name or wf})
    return out


def resolve(cfg, sid, agent):
    """Transcript path for a session or one of its agents, or None. Only validated ids reach the file system."""
    tdir = cfg['transcripts_dir']
    if not tdir or not SID_RE.match(sid or ''):
        return None
    if not agent:
        p = os.path.join(tdir, sid + '.jsonl')
        return p if os.path.exists(p) else None
    if not AGENT_RE.match(agent):
        return None
    return next((a['path'] for a in agent_files(tdir, sid) if a['agent'] == agent), None)


def add_usage(a, b):
    out = {k: (a or {}).get(k, 0) + (b or {}).get(k, 0) for k in ('in', 'out', 'cr', 'cc', 'turns')}
    out['complete'] = bool((a or {}).get('complete', True)) and bool((b or {}).get('complete', True)) if (a or b) else True
    return out


def _view(reader, now, cfg, reg, external=None, agent_mtimes=(), is_agent=False):
    """State + completeness fields shared by sessions and agents."""
    oldest = min((st_epoch for st_epoch in (epoch(t) for t in reader.pending.values()) if st_epoch), default=0)
    state, why, src = st.classify_state(
        now, reader.mtime, cfg['active_seconds'], reader.last_stop, len(reader.pending), oldest, list(agent_mtimes),
        cfg['pending_tool_grace_seconds'], registry=reg, external=external, has_records=bool(reader.total or reader.msgs) and not reader.unreadable)
    if is_agent and state == 'IDLE' and reader.last_stop in st.END_STOPS:
        state, why = 'COMPLETED', 'subagent ended its turn (%s); it continues only if its parent resumes it' % reader.last_stop
    return {'state': state, 'state_evidence': why, 'state_source': src, 'pending_tools': len(reader.pending), 'completeness': reader.completeness()}


def list_sessions(cfg, pool, hours, show_all, external=None):
    """Sessions touched within `hours`, newest first. external maps session id -> {state, evidence} (attempts table)."""
    tdir = cfg['transcripts_dir']
    if not tdir:
        return []
    now, res, reg = time.time(), [], st.registry()
    pinned = set(cfg.get('session_ids') or [])
    for p in glob.glob(os.path.join(tdir, '*.jsonl')):
        sid = os.path.basename(p)[:-6]
        if not SID_RE.match(sid):
            continue
        try:
            age = now - os.path.getmtime(p)
        except OSError:
            continue
        if age > hours * 3600 and sid not in pinned:
            continue
        label, matched = classify(cfg, p)
        if pinned and sid in pinned:
            matched = True
        if not (matched or show_all or cfg['include_unmatched']):
            continue
        rd = pool.get(p)
        own = rd.usage()
        total, ags, amt = add_usage(own, None), [], []
        for a in agent_files(tdir, sid):
            try:
                amt_ = os.path.getmtime(a['path'])
            except OSError:
                continue
            ard = pool.get(a['path'])
            u = ard.usage()
            total = add_usage(total, u)
            amt.append(amt_)
            aage = now - amt_
            view = _view(ard, now, cfg, None, is_agent=True)
            ags.append({'agent': a['agent'], 'label': a['label'], 'model': a['model'], 'workflow': a['workflow'], 'age': int(aage),
                        'size': ard.size, 'usage': u, 'done': aage >= 60 and u.get('stop') in st.END_STOPS, **view})
        ags.sort(key=lambda x: x['age'])
        view = _view(rd, now, cfg, reg.get(sid), (external or {}).get(sid), amt)
        res.append({'id': sid, 'label': label, 'matched': matched, 'age': int(age), 'size': rd.size, 'agents': ags,
                    'usage': own, 'usage_total': total, 'first_epoch': epoch(own.get('first', '')),
                    'done': age >= cfg['active_seconds'] and own.get('stop') in st.END_STOPS and not any(x['age'] < 60 for x in ags), **view})
    res.sort(key=lambda x: x['age'])
    return res

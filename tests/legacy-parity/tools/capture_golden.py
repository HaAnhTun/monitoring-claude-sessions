#!/usr/bin/env python
"""Golden capture of the legacy engine (design 06 section 5.2, ADR 0053): a frozen clock, seeded ids, in-process legacy server.

    python -B tests/legacy-parity/tools/capture_golden.py --out tests/legacy-parity/golden [--port-base 18850] [--tz UTC] [--trees DIR]
    python -B tests/legacy-parity/tools/capture_golden.py --check [--golden tests/legacy-parity/golden] [--port-base 18850] [--tz ZONE]

Python standard library only (>= 3.8). The legacy code under src/, tests/fixtures and tests/tools is imported read-only; nothing is
patched on disk. All work happens in one temp folder (`mcs-golden-*`) that is removed at the end; the only other thing written
is the output folder. Exit codes: 0 success / no drift, 1 drift or failure, 2 usage error or an environment the goldens
cannot be captured in (other Python minor version or platform than the recorded ones, forbidden port or output folder).
See tests/legacy-parity/README.md.
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import warnings

GENERATOR_VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
DEFAULT_GOLDEN = os.path.join(SKILL, 'tests', 'legacy-parity', 'golden')
GOLDEN_ENTRIES = ('meta.json', 'trees', 'api', 'cli', 'vectors')
STAGING_PREFIX = '.golden-staging-'
PORT_RANGE = (18850, 18855)       # the legacy bind() scans +19, so the server stays inside 18850-18874
RESERVED_SCENARIOS = ('fixture', 'demo', 'rules', 'panels', 'registry', 'task-lifecycle')
MAX_REPORT_LINES = 40
UNKNOWN_SID = '00000000-0000-4000-8000-ffffffffffff'


# ---- command line and process bootstrap (no sibling imports before bytecode writing is off) ------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(prog='capture_golden.py', description='Capture or check the legacy-parity goldens.')
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--out', metavar='DIR', help='write the goldens into this folder (created if missing)')
    mode.add_argument('--check', action='store_true', help='regenerate and compare with --golden; exit 1 on any difference')
    p.add_argument('--golden', metavar='DIR', help='folder to compare with in --check mode (default tests/legacy-parity/golden)')
    p.add_argument('--port-base', type=int, default=PORT_RANGE[0], help='first port of the legacy server (%d-%d)' % PORT_RANGE)
    p.add_argument('--tz', help='time zone for local-time parsing (default UTC; --check defaults to the zone recorded in meta.json)')
    p.add_argument('--trees', metavar='DIR', help='folder of testkit-built trees to serve as extra scenarios (one sub-folder each); '
                                                'pass the same folder to --check when the goldens contain them')
    a = p.parse_args(argv)
    if a.out is not None and not a.out.strip():
        p.error('--out needs a folder name')
    if a.golden and not a.check:
        p.error('--golden is only valid with --check')
    if not PORT_RANGE[0] <= a.port_base <= PORT_RANGE[1]:
        p.error('--port-base must be %d-%d (the legacy server must stay inside 18850-18874)' % PORT_RANGE)
    return a


def _reexec(env_add):
    """Run this script again in a fresh interpreter with a changed environment, and exit with its code."""
    count = int(os.environ.get('MCS_GOLDEN_REEXEC', '0'))
    if count >= 2:
        sys.stderr.write('capture_golden: could not establish the required interpreter settings after two restarts\n')
        sys.exit(1)
    env = dict(os.environ)
    env.update(env_add)
    env['MCS_GOLDEN_REEXEC'] = str(count + 1)
    sys.exit(subprocess.call([sys.executable, '-B', os.path.abspath(__file__)] + sys.argv[1:], env=env))


def _golden_meta(path):
    try:
        with open(os.path.join(path, 'meta.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def bootstrap(a):
    """Make sure no bytecode is written (no __pycache__ in the skill tree) and TZ is set before the interpreter starts."""
    if not sys.dont_write_bytecode:
        _reexec({'PYTHONDONTWRITEBYTECODE': '1'})
    import determinism as D
    tz = a.tz
    if tz is None:
        meta = _golden_meta(a.golden or DEFAULT_GOLDEN) if a.check else None
        tz = meta.get('tz', 'UTC') if meta else 'UTC'
    try:
        want = D.tz_env_value(tz)
    except ValueError as e:
        sys.stderr.write('capture_golden: %s\n' % e)
        sys.exit(2)
    if os.environ.get('TZ') != want:
        _reexec({'TZ': want, 'PYTHONDONTWRITEBYTECODE': '1'})
    return tz


# ---- output ------------------------------------------------------------------------------------------------------------------

def dump_golden(v):
    """json.dump(v, f, indent=1, sort_keys=True, ensure_ascii=False) + LF, UTF-8 (design 06 5.2.1)."""
    return (json.dumps(v, indent=1, sort_keys=True, ensure_ascii=False) + '\n').encode('utf-8')


BS = chr(92)
EXTENDED, EXTENDED_UNC, DEVICE = BS * 2 + '?' + BS, BS * 2 + '?' + BS + 'UNC' + BS, BS * 2 + '.' + BS


def _plain(path):
    """Drop the extended-length prefixes (BS BS ? BS, also with UNC) so that two spellings of one place compare equal."""
    if path.startswith(EXTENDED_UNC):
        return BS * 2 + path[len(EXTENDED_UNC):]
    if path.startswith(EXTENDED) or path.startswith(DEVICE):
        return path[4:]
    return path


def _existing_ancestor(path):
    """(longest existing ancestor of path, the missing tail as a list of names)."""
    head, tail = os.path.abspath(path), []
    while not os.path.lexists(head):
        up, name = os.path.split(head)
        if up == head or not name:
            break
        tail.append(name)
        head = up
    return head, tail[::-1]


def _inside(path, parent):
    """True when path is parent or lies below it, however either is spelled: case, short names, `..`, junctions and links, extended-length
    and UNC forms (an administrative share such as D$ of any host name), also when the leaf does not exist yet. The names are compared after resolving the longest
    existing ancestor, and the file identity (volume and file index) of every ancestor is compared with the parent, which catches the
    spellings that no name comparison can know (administrative shares of any host name)."""
    head, tail = _existing_ancestor(path)
    mine = os.path.normcase(os.path.join(os.path.realpath(_plain(head)), *tail))
    theirs = os.path.normcase(os.path.realpath(_plain(parent)))
    if mine == theirs or mine.startswith(theirs + os.sep):
        return True
    try:
        pst = os.stat(parent)
    except OSError:
        return False
    if not pst.st_ino:
        return False
    cur = head
    while True:
        try:
            if os.path.samestat(os.stat(cur), pst):
                return True
        except OSError:
            pass
        up = os.path.dirname(cur)
        if up == cur:
            return False
        cur = up


def _golden_names(names):
    return all(n in GOLDEN_ENTRIES or n.startswith(STAGING_PREFIX) for n in names)


def check_out_folder(out):
    """Refuse a target that is legacy-owned, the skill root or one of its ancestors, or a non-empty folder that is not a golden folder
    (one with a meta.json, or a partial one that holds only golden entries, as an interrupted earlier run leaves it)."""
    for sub in ('src', 'template', 'config', 'reference', 'docs', 'runtime', os.path.join('tests', 'fixtures'), os.path.join('tests', 'tools'),
                os.path.join('tests', 'frontend')):
        if _inside(out, os.path.join(SKILL, sub)):
            return 'refusing to write into legacy-owned path %s' % os.path.join(SKILL, sub)
    if _inside(SKILL, out):
        return 'refusing to write into the skill root or one of its parents'
    if os.path.exists(out) and not os.path.isdir(out):
        return '%s exists and is not a folder' % out
    if os.path.isdir(out):
        names = os.listdir(out)
        if names and not _golden_meta(out) and not _golden_names(names):
            return '%s is not empty and holds neither a golden meta.json nor only golden entries: refusing to clean it' % out
    return None


class WriteError(Exception):
    pass


def write_golden(out, files):
    """Replace the golden entries of `out` all or nothing. The new golden is written into a staging folder inside `out` first; then each
    old entry is renamed into the staging folder and each new entry into place. A failure (on Windows a file held open by another
    process makes the rename of its folder fail) renames everything back, so the previous golden stays complete. Foreign files in
    `out` are never touched."""
    os.makedirs(out, exist_ok=True)
    stage = tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=out)
    new, old = os.path.join(stage, 'new'), os.path.join(stage, 'old')
    os.makedirs(old)
    moved_old, moved_new = [], []
    keep_stage = False
    try:
        try:
            for rel in sorted(files):
                p = os.path.join(new, *rel.split('/'))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, 'wb') as f:
                    f.write(files[rel])
            for name in GOLDEN_ENTRIES:
                if os.path.lexists(os.path.join(out, name)):
                    os.rename(os.path.join(out, name), os.path.join(old, name))
                    moved_old.append(name)
            for name in GOLDEN_ENTRIES:
                if os.path.lexists(os.path.join(new, name)):
                    os.rename(os.path.join(new, name), os.path.join(out, name))
                    moved_new.append(name)
        except OSError as e:
            lost = []
            for name in reversed(moved_new):
                try:
                    os.rename(os.path.join(out, name), os.path.join(new, name))
                except OSError:
                    lost.append(name)
            for name in reversed(moved_old):
                try:
                    os.rename(os.path.join(old, name), os.path.join(out, name))
                except OSError:
                    lost.append(name)
            if lost:
                keep_stage = True
                raise WriteError('%s; could not restore %s, the previous golden is kept in %s' % (e, ', '.join(sorted(set(lost))), old))
            raise WriteError('%s; the previous golden is unchanged' % e)
    finally:
        if not keep_stage:
            shutil.rmtree(stage, ignore_errors=True)


def read_golden(folder):
    out = {}
    for d, _, names in os.walk(folder):
        for n in names:
            p = os.path.join(d, n)
            with open(p, 'rb') as f:
                out[os.path.relpath(p, folder).replace(os.sep, '/')] = f.read()
    return out


def first_difference(a, b, ptr=''):
    """(json pointer, value in a, value in b) of the first difference, or None."""
    if type(a) is not type(b):
        return ptr or '/', a, b
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            sub = ptr + '/' + str(k).replace('~', '~0').replace('/', '~1')
            if k not in a or k not in b:
                return sub, a.get(k, '<absent>'), b.get(k, '<absent>')
            r = first_difference(a[k], b[k], sub)
            if r:
                return r
        return None
    if isinstance(a, list):
        for i in range(min(len(a), len(b))):
            r = first_difference(a[i], b[i], '%s/%d' % (ptr, i))
            if r:
                return r
        if len(a) != len(b):
            return '%s/%d' % (ptr, min(len(a), len(b))), '<%d items>' % len(a), '<%d items>' % len(b)
        return None
    return None if a == b else (ptr or '/', a, b)


def _clip(v):
    s = json.dumps(v)
    return s if len(s) <= 120 else s[:117] + '...'


class _Unparsable(object):
    """Stands for a side of a drift report that is not valid UTF-8 JSON (an empty or damaged golden file)."""

    def __init__(self, raw):
        self.text = raw[:120].decode('utf-8', 'replace')


def _parse(raw):
    try:
        return json.loads(raw.decode('utf-8'))
    except ValueError:
        return _Unparsable(raw)


def _show(v):
    return '<unparsable: %r>' % v.text if isinstance(v, _Unparsable) else _clip(v)


def compare(golden_dir, new_files, python_same_minor):
    """Print one line per difference; returns the number of differences."""
    old = read_golden(golden_dir)
    n_diff, shown = 0, [0]

    def say(line):
        shown[0] += 1
        if shown[0] <= MAX_REPORT_LINES:
            print(line)
        elif shown[0] == MAX_REPORT_LINES + 1:
            print('... further differences are counted but not listed')

    for rel in sorted(set(old) | set(new_files)):
        if rel not in old:
            say('MISSING %s: generated but absent from %s' % (rel, golden_dir))
            n_diff += 1
        elif rel not in new_files:
            say('EXTRA %s: present in %s but not generated' % (rel, golden_dir))
            n_diff += 1
        elif old[rel] != new_files[rel]:
            a, b = _parse(old[rel]), _parse(new_files[rel])
            if isinstance(a, _Unparsable) or isinstance(b, _Unparsable):
                d = ('/', a, b)
            else:
                if rel == 'meta.json':
                    a, b = dict(a), dict(b)
                    for k in ('port_base', 'python_version') if python_same_minor else ('port_base',):
                        a.pop(k, None)
                        b.pop(k, None)
                d = first_difference(a, b)
            if rel == 'meta.json' and d is None:
                continue
            if d is None:
                say('DIFF %s: same JSON value, different bytes (formatting only)' % rel)
            else:
                say('DIFF %s at %s: golden=%s generated=%s' % (rel, d[0], _show(d[1]), _show(d[2])))
            n_diff += 1
    return n_diff


def legacy_code_stamp():
    """backend.code_stamp() over line-ending-normalised bytes: the same files in the same order (sorted src/backend/*.py as base name plus
    content, then config/defaults.json), the same sha1 cut to ten characters, but CRLF read as LF. A checkout with another
    core.autocrlf or eol setting then gives the same stamp; the legacy function hashes the raw bytes and does not."""
    bdir = os.path.join(SKILL, 'src', 'backend')
    paths = [os.path.join(bdir, n) for n in sorted(os.listdir(bdir)) if n.endswith('.py')]
    paths.append(os.path.join(SKILL, 'config', 'defaults.json'))
    h = hashlib.sha1()
    for path in paths:
        try:
            with open(path, 'rb') as f:
                h.update(os.path.basename(path).encode() + f.read().replace(b'\r\n', b'\n'))
        except OSError:
            pass
    return h.hexdigest()[:10]


# ---- the capture -------------------------------------------------------------------------------------------------------------

class Client(object):
    """Talks to the in-process legacy server; replaces nothing in it."""

    def __init__(self, L, D, tmp, port_base):
        self.L, self.D, self.tmp, self.port_base = L, D, tmp, port_base
        self.srv = self.thread = None
        self.port = None

    def use(self, mon):
        """Serve `mon` (one server for the whole run; scenarios swap the monitor behind it)."""
        if self.srv is None:
            srv, port = self.L.server.bind(mon, self.port_base)
            if srv is None or not PORT_RANGE[0] <= port <= PORT_RANGE[0] + 24:
                if srv is not None:
                    srv.server_close()
                raise RuntimeError('no free port in 18850-18874 for the legacy server')
            self.srv, self.port = srv, port
            self.thread = threading.Thread(target=srv.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
            self.thread.start()
        else:
            self.srv.mon = mon

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=60)
        try:
            conn.request('GET', path, headers=headers or {})
            r = conn.getresponse()
            raw = r.read().decode('utf-8')
            if (r.getheader('Content-Type') or '').startswith('application/json'):
                return r.status, json.loads(raw)
            return r.status, raw
        finally:
            conn.close()

    def close(self):
        if self.srv is not None:
            if self.thread is not None:
                self.srv.shutdown()
            self.srv.server_close()
            if self.thread is not None:
                self.thread.join(10)
            self.srv = self.thread = None


def typeof(v):
    return 'null' if v is None else 'boolean' if isinstance(v, bool) else 'number' if isinstance(v, (int, float)) else \
        'string' if isinstance(v, str) else 'array' if isinstance(v, list) else 'object'


class Capture(object):
    def __init__(self, L, D, P, V, tmp, port_base, tz):
        self.L, self.D, self.P, self.V = L, D, P, V
        self.tmp, self.tz = tmp, tz
        self.client = Client(L, D, tmp, port_base)
        self.norm = D.Normalizer(tmp)
        self.files = {}
        self.scenarios = []
        self.port_base = port_base

    # -- helpers
    def put(self, rel, value):
        self.files[rel] = dump_golden(self.norm.value(value))

    def monitor(self, name, cfg_or_path, home):
        """A Monitor over a legacy flat config (dict written to a file, or an existing file), with CLAUDE_CONFIG_DIR at `home`."""
        os.environ['CLAUDE_CONFIG_DIR'] = home
        if isinstance(cfg_or_path, dict):
            path = os.path.join(self.tmp, 'configs', name + '.config.json')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(cfg_or_path, f, indent=2)
        else:
            path = cfg_or_path
        cfg, meta = self.L.C.resolve_runtime(config_path=path, task_dir=None)
        mon = self.L.server.Monitor(cfg, meta)
        self.client.use(mon)
        return mon

    def get(self, path, headers=None):
        return list(self.client.get(path, headers))

    def api_set_a(self, ids):
        """API set A of design 06 5.2.4. ids: {key: session id}. Returns {name: [status, body]}."""
        api = {}

        def get(name, path, headers=None):
            api[name] = self.get(path, headers)
            return api[name]

        get('sessions-all', '/api/sessions?all=1')
        get('sessions', '/api/sessions')
        get('sessions-hours-0.1-all', '/api/sessions?hours=0.1&all=1')
        for name in ('attempts', 'overview', 'logs', 'config', 'task'):
            get(name, '/api/' + name)
        status, rows = api['sessions-all']
        if status != 200 or not isinstance(rows, list):
            raise RuntimeError('/api/sessions?all=1 failed: %s' % status)
        key_of = {sid: key for key, sid in ids.items()}
        for key in sorted(ids):
            q = '/api/%s?sid=' + ids[key]
            _, ev = get('events.' + key, q % 'events')
            get('events-after0-limit5.' + key, (q % 'events') + '&after=0&limit=5')
            get('events-before5-limit3.' + key, (q % 'events') + '&before=5&limit=3')
            get('search-q-step.' + key, (q % 'search') + '&q=step')
            get('search-errors.' + key, (q % 'search') + '&errors=1')
            get('search-tool-bash.' + key, (q % 'search') + '&kinds=tool&tool=Bash')
            get('locate-i0.' + key, (q % 'locate') + '&i=0')
            if isinstance(ev, dict) and ev.get('events'):
                get('locate-ts.' + key, (q % 'locate') + '&ts=' + urllib.parse.quote(ev['events'][0]['t'], safe=''))
        for s in rows:
            for ag in s['agents']:
                get('events-agent.%s.%s' % (key_of.get(s['id'], s['id']), ag['agent']), '/api/events?sid=%s&agent=%s' % (s['id'], ag['agent']))
        first = sorted(ids.values())[0]
        get('err-hours-x', '/api/sessions?hours=x')
        get('err-unknown-sid', '/api/events?sid=' + UNKNOWN_SID)
        get('err-after-x', '/api/events?sid=%s&after=x' % first)
        get('err-agent-traversal', '/api/events?sid=%s&agent=../x' % first)
        get('err-host-evil', '/api/sessions', {'Host': 'evil.example'})
        self.L.panels.CPU.clear()          # the first poll has no CPU baseline: cpu_pct is null on every machine
        status, body = self.get('/api/machine')
        api['machine-shape'] = [status, {k: typeof(v) for k, v in body.items()} if isinstance(body, dict) else body]
        status, body = self.get('/api/health')
        api['health'] = [status, {'keys': sorted(body), 'reader': body['reader']} if isinstance(body, dict) else body]
        return api

    def emit_scenario(self, name, api, tree_root=None):
        self.scenarios.append(name)
        for k, v in api.items():
            self.put('api/%s/%s.json' % (name, k), v)
        if tree_root:
            self.put('trees/%s.manifest.json' % name, self.D.manifest(tree_root, self.norm))

    # -- scenarios
    def fixture(self):
        D, L = self.D, self.L
        D.reset_uuids()
        fx = L.make.build_home(os.path.join(self.tmp, 'fixture-home'))
        D.freeze_untouched(fx['home'])
        cfg = {'title': 'fixture', 'repo': self.tmp, 'transcripts_dir': fx['tdir'], 'docker': False, 'panels': {'machine': False, 'git': False}}
        self.monitor('fixture', cfg, fx['home'])
        self.emit_scenario('fixture', self.api_set_a(fx['ids']), fx['home'])

    def demo(self):
        D, L = self.D, self.L
        D.reset_uuids()
        dm = L.demo.build(os.path.join(self.tmp, 'demo'))
        D.freeze_untouched(dm['out'])
        self.monitor('demo', os.path.join(dm['out'], 'demo.config.json'), dm['home'])
        self.emit_scenario('demo', self.api_set_a(dm['ids']), dm['out'])

    def rules(self):
        P = self.P
        root = os.path.join(self.tmp, 'rules')
        rt = P.rules_tree(root)
        self.D.freeze_untouched(root)
        api = {}
        for case in rt['cases']:
            self.monitor('rules-' + case['case'], P.rules_config(root, case), rt['home'])
            status, rows = self.get('/api/sessions?all=1')
            api['sessions-all.' + case['case']] = [status, [{'id': r['id'], 'label': r['label'], 'matched': r['matched']} for r in rows]
                                                   if isinstance(rows, list) else rows]
        self.emit_scenario('rules', api, root)
        return rt

    def panels(self):
        D, L, P = self.D, self.L, self.P
        root = os.path.join(self.tmp, 'panels')
        pt = P.panels_tree(root, L)
        D.freeze_untouched(root)
        api = {}
        self.monitor('panels', pt['cfg'], pt['home'])
        for name in ('logs', 'overview', 'attempts'):
            api[name] = self.get('/api/' + name)
        api['sessions-all'] = self.get('/api/sessions?all=1')
        for log in pt['log_names']:
            cfg = dict(pt['cfg'], live_log_globs=['logs/' + log])
            self.monitor('panels-' + log, cfg, pt['home'])
            api['logs.' + log] = self.get('/api/logs')
        self.emit_scenario('panels', api, root)

    def registry(self):
        D, P = self.D, self.P
        root = os.path.join(self.tmp, 'registry')
        rt = P.registry_tree(root, self.L)
        cfg = {'title': 'registry', 'repo': root, 'transcripts_dir': rt['tdir'], 'docker': False, 'panels': {'machine': False, 'git': False}}
        self.monitor('registry', cfg, rt['home'])
        api = {'sessions-all': self.get('/api/sessions?all=1'), 'sessions': self.get('/api/sessions')}
        self.emit_scenario('registry', api, root)

    def task_lifecycle(self):
        import contextlib
        import io
        L = self.L
        os.environ['CLAUDE_CONFIG_DIR'] = os.path.join(self.tmp, 'empty-home')
        repo = os.path.join(self.tmp, 'lifecycle-repo')
        os.makedirs(repo)
        slug = 'nightly-build-steps-a-b'
        rule = '[{"match":"STEP=([A-Z])","label":"step {1}"}]'
        script = [
            ['init-task', '--repo', '<REPO>', '--name', 'Nightly build: Steps A/B'],
            ['configure', '--repo', '<REPO>', '--task', slug, '--set', 'window_hours=12', '--set', 'panels.git=false', '--reason', 'golden'],
            ['configure', '--repo', '<REPO>', '--task', slug, '--unset', 'window_hours', '--reason', 'golden'],
            ['configure', '--repo', '<REPO>', '--task', slug, '--set', 'session_rules=' + rule],
            ['decide', '--repo', '<REPO>', '--task', slug, '--title', 'Use attempts', '--decision', 'chain log', '--rejected', 'none'],
            ['inspect', '--repo', '<REPO>', '--task', slug],
            ['audit', '--repo', '<REPO>'],
            ['configure', '--repo', '<REPO>', '--task', slug, '--set', 'schema_version=2'],
            ['configure', '--repo', '<REPO>', '--task', slug, '--set', 'nope=1'],
        ]
        commands = []
        for argv in script:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = L.cli.main([repo if x == '<REPO>' else x for x in argv])
                except SystemExit as e:
                    code = e.code
            stdout = re.sub(r'"config_hash": "[0-9a-f]+"', '"config_hash": "<MACHINE>"', out.getvalue())
            commands.append({'argv': argv, 'exit': code, 'stdout': stdout, 'stderr': err.getvalue()})
        wdir = os.path.join(repo, '.claude', 'monitor', 'tasks', slug)
        files = {}
        for d, _, names in os.walk(wdir):
            for n in names:
                p = os.path.join(d, n)
                with open(p, 'rb') as f:
                    files[os.path.relpath(p, wdir).replace(os.sep, '/')] = f.read().decode('utf-8')
        self.scenarios.append('task-lifecycle')
        self.put('cli/task-lifecycle.json', {'commands': commands, 'files': files})

    def extra_trees(self, trees_dir):
        """Serve testkit-built trees: each sub-folder holds `home/` (a fake CLAUDE_CONFIG_DIR) and optionally `repo/`."""
        D = self.D
        names = sorted(n for n in os.listdir(trees_dir) if os.path.isdir(os.path.join(trees_dir, n)))
        for name in names:
            if not all(c.isalnum() or c in '-_' for c in name) or name in RESERVED_SCENARIOS:
                raise ValueError('tree folder name %r is not usable as a scenario name' % name)
            root = os.path.join(self.tmp, 'tree-' + name)
            shutil.copytree(os.path.join(trees_dir, name), root)         # copied: freezing mtimes must not touch the source
            D.freeze_untouched(root)
            home = os.path.join(root, 'home')
            projects = os.path.join(home, 'projects')
            subs = sorted(os.listdir(projects)) if os.path.isdir(projects) else []
            if not subs:
                raise ValueError('tree %r has no home/projects/<project> folder' % name)
            tdir = os.path.join(projects, subs[0])
            repo = os.path.join(root, 'repo') if os.path.isdir(os.path.join(root, 'repo')) else root
            cfg = {'title': name, 'repo': repo, 'transcripts_dir': tdir, 'docker': False, 'panels': {'machine': False, 'git': False}}
            self.monitor('tree-' + name, cfg, home)
            status, rows = self.get('/api/sessions?all=1')
            ids = {r['id']: r['id'] for r in rows} if status == 200 and isinstance(rows, list) and rows else {UNKNOWN_SID: UNKNOWN_SID}
            self.emit_scenario(name, self.api_set_a(ids), root)

    def vectors(self, rules_tree):
        vtmp = os.path.join(self.tmp, 'vectors')
        os.makedirs(vtmp)
        os.environ['CLAUDE_CONFIG_DIR'] = os.path.join(self.tmp, 'empty-home')
        built = self.V.build_all(self.L, {'tmp': vtmp, 'rules': rules_tree})
        for name, rows in built.items():
            self.put('vectors/%s.json' % name, rows)
        return sorted(built)

    def meta(self, vector_names):
        L = self.L
        v = sys.version_info
        return {'generator_version': GENERATOR_VERSION, 'legacy_version': L.backend.__version__, 'legacy_code_stamp': legacy_code_stamp(),
                'python_version': '%d.%d.%d' % v[:3], 'python_minor': '%d.%d' % v[:2], 'platform': sys.platform, 'frozen_now': self.D.FROZEN_NOW,
                'frozen_now_iso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.D.FROZEN_NOW)), 'tz': self.tz, 'port_base': self.port_base,
                'uuid_pattern': '%08x-0000-4000-8000-%012x', 'uuid_restarts_per_scenario_at': 1,
                'scenarios': sorted(self.scenarios), 'vectors': vector_names}


def run_capture(a, tz):
    import determinism as D
    import panel_scenarios as P
    import vectors as V
    warnings.filterwarnings('ignore', category=FutureWarning)     # legacy re.compile of the literal-set pattern of matrix case R29
    tmp = tempfile.mkdtemp(prefix='mcs-golden-')
    cap = None
    try:
        os.environ['CLAUDE_CONFIG_DIR'] = os.path.join(tmp, 'empty-home')
        os.makedirs(os.environ['CLAUDE_CONFIG_DIR'])
        D.verify_tz(tz)
        L = D.load_legacy(SKILL)
        cap = Capture(L, D, P, V, tmp, a.port_base, tz)
        cap.fixture()
        cap.demo()
        rules_tree = cap.rules()
        cap.panels()
        cap.registry()
        cap.task_lifecycle()
        if a.trees:
            cap.extra_trees(os.path.abspath(a.trees))
        names = cap.vectors(rules_tree)
        cap.put('meta.json', cap.meta(names))
        return dict(cap.files)
    finally:
        if cap is not None:
            cap.client.close()
        for attempt in range(5):
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                break
            time.sleep(0.2)
        if os.path.exists(tmp):
            sys.stderr.write('capture_golden: could not remove temp folder %s\n' % tmp)


def real_claude_homes():
    homes = {os.path.join(os.path.expanduser('~'), '.claude')}
    if os.environ.get('CLAUDE_CONFIG_DIR'):
        homes.add(os.environ['CLAUDE_CONFIG_DIR'])
    return homes


def main():
    for stream in (sys.stdout, sys.stderr):      # a console code page must never turn a message into a crash
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='backslashreplace')
    a = parse_args(sys.argv[1:])
    if a.trees:
        if not os.path.isdir(a.trees):
            sys.stderr.write('capture_golden: --trees folder not found: %s\n' % a.trees)
            return 2
        if any(_inside(a.trees, h) or _inside(h, a.trees) for h in real_claude_homes()):
            sys.stderr.write('capture_golden: refusing --trees that overlaps a real Claude home (goldens never come from real transcripts)\n')
            return 2
    out = None
    if a.out is not None:
        out = os.path.abspath(a.out)
        problem = check_out_folder(out)
        if problem:
            sys.stderr.write('capture_golden: %s\n' % problem)
            return 2
    golden = os.path.abspath(a.golden or DEFAULT_GOLDEN)
    if a.check:
        meta = _golden_meta(golden)
        if meta is None:
            sys.stderr.write('capture_golden: %s has no readable meta.json: nothing to check against\n' % golden)
            return 2
        minor = '%d.%d' % sys.version_info[:2]
        if meta.get('python_minor') != minor:
            sys.stderr.write('capture_golden: goldens were captured with Python %s but this is Python %s: refusing to compare\n'
                             % (meta.get('python_minor'), minor))
            return 2
        if meta.get('platform') != sys.platform:
            sys.stderr.write('capture_golden: goldens were captured on %s but this is %s (legacy trees contain text-mode CRLF files): refusing to compare\n'
                             % (meta.get('platform'), sys.platform))
            return 2
    tz = bootstrap(a)
    try:
        files = run_capture(a, tz)
    except ValueError as e:
        sys.stderr.write('capture_golden: %s\n' % e)
        return 2
    if a.check:
        same_minor = True
        n_diff = compare(golden, files, same_minor)
        if n_diff:
            print('golden check: %d difference(s) in %s' % (n_diff, golden))
            return 1
        print('golden check: %d files identical' % len(files))
        return 0
    try:
        write_golden(out, files)
    except (OSError, WriteError) as e:
        sys.stderr.write('capture_golden: could not write %s: %s\n' % (out, e))
        return 1
    print('golden written: %d files, %d bytes -> %s' % (len(files), sum(len(b) for b in files.values()), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())

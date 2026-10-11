"""Command line: discover, init-task, inspect, configure, audit, start, verify, status, stop, doctor (+ legacy flags).

Every command prints a result and exits 0 on success, 1 on failure, 2 on bad usage. Nothing reports success before
the outcome was checked (start waits for /api/health; stop checks the process is gone).
"""
import argparse, glob, json, os, re, subprocess, sys, time, urllib.error, urllib.request, webbrowser

from . import __version__, code_stamp, config as C, panels, sessions, state as st, tasks
from .server import Monitor, bind


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False) if not isinstance(obj, str) else obj)


def fail(msg, code=1):
    print('ERROR: ' + msg, file=sys.stderr)
    return code


# ------------------------------------------------------------------ helpers

def resolve_ctx(a):
    """Locate tasks root and (optionally) the task. Returns dict(root, repo, slug, dir, config)."""
    repo = os.path.abspath(a.repo)
    root = os.path.abspath(a.root) if getattr(a, 'root', None) else tasks.tasks_root(repo)
    slug = getattr(a, 'task', None)
    return {'repo': repo, 'root': root, 'slug': slug, 'dir': tasks.task_dir(root, slug) if slug else None,
            'config': getattr(a, 'config', None)}


def build_monitor(ctx):
    cfg, meta = C.resolve_runtime(config_path=ctx['config'], task_dir=ctx['dir'])
    return Monitor(cfg, meta)


def state_file(ctx):
    if ctx['dir']:
        return os.path.join(ctx['dir'], 'state.json')
    if ctx['config']:
        return os.path.abspath(ctx['config']) + '.state.json'
    return os.path.join(ctx['repo'], '.claude', 'monitor', 'default.state.json')


def read_state_file(p):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def http_json(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def cmdline_of(pid):
    if os.name == 'nt':
        return subprocess.run(['powershell', '-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d').CommandLine" % pid],
                              capture_output=True, text=True, timeout=20).stdout
    try:
        with open('/proc/%d/cmdline' % pid) as f:
            return f.read().replace(chr(0), ' ')
    except OSError:
        return ''


def instance_alive(sf):
    """(alive, info). A state file counts only when its pid is alive AND answers /api/health with that same pid
    (a reused pid or a stale file is reported as dead, never trusted)."""
    info = read_state_file(sf)
    if not info:
        return False, None
    if not st.pid_alive(info.get('pid')):
        return False, info
    try:
        h = http_json(info['url'] + '/api/health', 3)
        return h.get('pid') == info['pid'], info
    except Exception:
        return False, info


# ------------------------------------------------------------------ commands

def cmd_discover(a):
    repo = os.path.abspath(a.repo)
    tdir = sessions.detect_transcripts_dir(repo)
    print('repo: ' + repo)
    print('transcripts: ' + (tdir or '(not found: pass transcripts_dir explicitly)'))
    if tdir:
        files = sorted(glob.glob(os.path.join(tdir, '*.jsonl')), key=os.path.getmtime, reverse=True)[:15]
        print('recent sessions (newest first):')
        for p in files:
            head = sessions.real_first_prompt(p).strip().replace('\n', ' ')[:110]
            print('  %s  %5.0fs ago  %8d B  %s' % (os.path.basename(p)[:-6], time.time() - os.path.getmtime(p), os.path.getsize(p), head))
    for pat in ('logs/*.log', '*.log'):
        for p in glob.glob(os.path.join(repo, pat))[:5]:
            print('log candidate: ' + os.path.relpath(p, repo))
    for p in glob.glob(os.path.join(repo, '**', '*status*.md'), recursive=True)[:5]:
        if 'node_modules' not in p:
            print('ledger candidate: ' + os.path.relpath(p, repo))
    root = tasks.tasks_root(repo)
    print('tasks: ' + (', '.join(tasks.list_tasks(root)) or '(none)') + '  [' + root + ']')
    return 0


def cmd_init(a):
    ctx = resolve_ctx(a)
    d, created = tasks.init_task(ctx['root'], ctx['repo'], a.name, a.slug, a.description or '')
    slug = os.path.basename(d)
    print(('created' if created else 'reused (nothing overwritten)') + ' task %r at %s' % (slug, d))
    return 0


def cmd_inspect(a):
    ctx = resolve_ctx(a)
    if not ctx['slug']:
        print('tasks: ' + (', '.join(tasks.list_tasks(ctx['root'])) or '(none)'))
        return 0
    info = tasks.inspect(ctx['root'], ctx['slug'])
    audit_tail = ''
    try:
        with open(os.path.join(info['dir'], 'audit', 'changes.md'), encoding='utf-8') as f:
            audit_tail = ''.join(re.split(r'(?m)^(?=## )', f.read())[-3:])
    except OSError:
        pass
    info['recent_audit'] = audit_tail
    inherited = sorted(k for k, v in info['provenance'].items() if v == 'default')
    over = sorted(k for k, v in info['provenance'].items() if v != 'default')
    info['overridden_keys'], info['inherited_keys'] = over, inherited
    out(info)
    return 0


def parse_value(s):
    try:
        return json.loads(s)
    except ValueError:
        return s


def cmd_configure(a):
    ctx = resolve_ctx(a)
    if not ctx['slug']:
        return fail('configure needs --task SLUG', 2)
    sets = {}
    for item in a.set or []:
        k, sep, v = item.partition('=')
        if not sep:
            return fail('--set expects KEY=JSON_VALUE, got %r' % item, 2)
        sets[k.strip()] = parse_value(v)
    before = tasks.snapshot(ctx['root'], exclude=ctx['slug'])
    rep = tasks.configure(ctx['dir'], sets, a.unset or [], a.reason or '', a.decision or '')
    if tasks.snapshot(ctx['root'], exclude=ctx['slug']) != before:
        return fail('isolation violated: another task changed during configure (this is a bug)')
    out(rep)
    return 0


def cmd_decide(a):
    ctx = resolve_ctx(a)
    tasks.record_decision(ctx['dir'], a.title, a.decision, a.rejected or '')
    print('recorded decision in ' + os.path.join(ctx['dir'], 'audit', 'decisions.md'))
    return 0


def cmd_audit(a):
    ctx = resolve_ctx(a)
    rep = tasks.audit_tasks(ctx['root'], [ctx['slug']] if ctx['slug'] else None)
    out(rep)
    return 0 if all(r['ok'] for r in rep) else 1


def cmd_start(a):
    ctx = resolve_ctx(a)
    build_monitor(ctx)                 # validates config before spawning anything
    sf = state_file(ctx)
    alive, info = instance_alive(sf)
    if alive:
        print('already running: ' + info['url'] + ' (pid %d)' % info['pid'])
        return 0
    if info:
        try:
            os.remove(sf)              # stale
        except OSError:
            pass
    cmd = [sys.executable, os.path.join(C.SKILL_DIR, 'template', 'viewer.py'), 'serve'] + (['--task', ctx['slug']] if ctx['slug'] else []) + \
          (['--config', ctx['config']] if ctx['config'] else []) + ['--repo', ctx['repo'], '--root', ctx['root'], '--state-file', sf]
    if a.port:
        cmd += ['--port', str(a.port)]
    kw = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
    if os.name == 'nt':
        kw['creationflags'] = 0x00000008 | 0x00000200 | 0x08000000      # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW
    else:
        kw['start_new_session'] = True
    subprocess.Popen(cmd, **kw)
    for _ in range(60):                # wait up to ~12 s for a healthy instance
        time.sleep(0.2)
        alive, info = instance_alive(sf)
        if alive:
            print('started: ' + info['url'] + ' (pid %d)' % info['pid'])
            if a.open:
                webbrowser.open(info['url'])
            return 0
    return fail('monitor did not become healthy within 12 s; run `doctor`' + (' --task ' + ctx['slug'] if ctx['slug'] else ''))


def cmd_serve(a):
    """Foreground server (also what `start` launches detached)."""
    ctx = resolve_ctx(a)
    mon = build_monitor(ctx)
    srv, port = bind(mon, a.port or mon.cfg['port'])
    if srv is None:
        return fail('no free port near %d' % (a.port or mon.cfg['port']))
    url = 'http://127.0.0.1:%d' % port
    print('monitor on %s (read-only, loopback only; Ctrl+C to stop)' % url, flush=True)
    sf = a.state_file or state_file(ctx)
    try:
        C.write_json_atomic(sf, {'pid': os.getpid(), 'url': url, 'port': port, 'started': time.time(), 'version': __version__,
                                 'task': ctx['slug'], 'config': ctx['config']})
    except OSError as e:
        mon.record_error('state', e)
    if a.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            info = read_state_file(sf)
            if info and info.get('pid') == os.getpid():
                os.remove(sf)
        except OSError:
            pass
    return 0


def cmd_verify(a):
    ctx = resolve_ctx(a)
    sf = state_file(ctx)
    alive, info = instance_alive(sf)
    if not alive:
        return fail('no healthy monitor for this target (state file: %s)' % sf)
    probs = []
    for ep in ('/api/health', '/api/config', '/api/sessions', '/api/overview'):
        try:
            data = http_json(info['url'] + ep, 5)
            if ep == '/api/sessions' and not isinstance(data, list):
                probs.append('/api/sessions did not return a list')
        except Exception as e:
            probs.append('%s: %s' % (ep, e))
    if probs:
        return fail('; '.join(probs))
    n = len(http_json(info['url'] + '/api/sessions'))
    print('verified %s: health, config, sessions (%d), overview all valid JSON' % (info['url'], n))
    return 0


def cmd_status(a):
    ctx = resolve_ctx(a)
    sf = state_file(ctx)
    alive, info = instance_alive(sf)
    res = {'running': alive, 'state_file': sf}
    if alive:
        h = http_json(info['url'] + '/api/health')
        ss = http_json(info['url'] + '/api/sessions')
        res.update({'url': info['url'], 'pid': info['pid'], 'uptime_s': h['uptime'], 'code_stamp': h.get('code_stamp'), 'outdated': h.get('code_stamp') != code_stamp(), 'task': h['task'], 'config_source': h['config_source'],
                    'recent_errors': h['errors'][-5:], 'reader': h['reader'],
                    'sessions': {s: sum(1 for x in ss if x['state'] == s) for s in ('RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN')},
                    'partial_sessions': sum(1 for x in ss if x['completeness']['events'] == 'partial' or x['completeness']['usage'] != 'complete'),
                    'newest_session_age_s': min((x['age'] for x in ss), default=None)})
    elif info:
        res['stale_state_file'] = info
    if res.get('outdated'):
        res['hint'] = 'the skill code changed since this monitor started: run `restart` to load it (frontend changes need only a page reload)'
    out(res)
    return 0 if alive else 1


def stop_target(sf):
    info = read_state_file(sf)
    if not info:
        return 'nothing to stop (no state file %s)' % sf, 0
    pid = int(info.get('pid', 0))
    cl = cmdline_of(pid) if st.pid_alive(pid) else ''
    if 'viewer.py' not in cl:
        os.remove(sf)
        return 'pid %d is not a viewer process (already stopped or pid reused); removed the stale state file, nothing was killed' % pid, 0
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True)
    else:
        os.kill(pid, 15)
    for _ in range(25):
        if not st.pid_alive(pid):
            break
        time.sleep(0.2)
    else:
        return 'pid %d still alive after stop request' % pid, 1
    try:
        os.remove(sf)
    except OSError:
        pass
    return 'stopped viewer pid %d (%s)' % (pid, info.get('url')), 0


def cmd_stop(a):
    ctx = resolve_ctx(a)
    msg, code = stop_target(state_file(ctx))
    print(msg)
    return code


def cmd_restart(a):
    ctx = resolve_ctx(a)
    msg, code = stop_target(state_file(ctx))
    print(msg)
    if code:
        return code
    return cmd_start(a)


def cmd_check(a):
    ctx = resolve_ctx(a)
    mon = build_monitor(ctx)
    c = mon.cfg
    on = ','.join(k for k, v in c['panels'].items() if v) or '(none)'
    print('title: %s | repo: %s | transcripts: %s | rules: %d | window: %sh | panels: %s | source: %s' % (
        c['title'], c['repo'], c['transcripts_dir'], len(c['session_rules']), c['window_hours'], on, mon.meta['source']))
    return 0


def cmd_doctor(a):
    ctx = resolve_ctx(a)
    checks = []

    def chk(name, ok, detail=''):
        checks.append({'check': name, 'ok': bool(ok), 'detail': detail})

    chk('python >= 3.8', sys.version_info >= (3, 8), sys.version.split()[0])
    mon = None
    try:
        mon = build_monitor(ctx)
        chk('config loads and validates', True, 'source=' + mon.meta['source'])
    except Exception as e:
        chk('config loads and validates', False, str(e))
    if mon:
        td = mon.cfg['transcripts_dir']
        chk('transcripts folder found', td and os.path.isdir(td), str(td) or 'set transcripts_dir or check repo')
        if td:
            files = sorted(glob.glob(os.path.join(td, '*.jsonl')), key=os.path.getmtime, reverse=True)[:5]
            bad = total = 0
            for p in files:
                rd = mon.pool.get(p)
                bad += rd.invalid_lines
                total += rd.total
            chk('recent transcripts parse', bad == 0 or bad < max(5, total // 100), '%d files, %d events, %d invalid lines' % (len(files), total, bad))
            rules = len(mon.cfg['session_rules'])
            n = len(sessions.list_sessions(mon.cfg, mon.pool, mon.cfg['window_hours'], False))
            chk('rules match at least one session', rules == 0 or n > 0, '%d rule(s), %d matching session(s) within %sh (older ones are hidden)' % (rules, n, mon.cfg['window_hours']))
        for key in ('chain_log', 'ledger'):
            if mon.cfg.get(key):
                chk(key + ' exists', os.path.exists(panels.rel(mon.cfg, mon.cfg[key])), mon.cfg[key])
    sf = state_file(ctx)
    alive, info = instance_alive(sf)
    if info and not alive:
        chk('state file is current', False, 'stale state file %s (pid %s dead or not answering); `start` replaces it, `stop` removes it' % (sf, info.get('pid')))
    elif alive:
        chk('running monitor answers', True, info['url'])
        h = http_json(info['url'] + '/api/health')
        chk('no recent server errors', not h['errors'], '; '.join('%s: %s' % (e['where'], e['message']) for e in h['errors'][-3:]))
    if ctx['slug'] is None and os.path.isdir(ctx['root']):
        for r in tasks.audit_tasks(ctx['root']):
            chk('task %s audit' % r['task'], r['ok'], '; '.join(r['problems']))
    elif ctx['slug']:
        r = tasks.audit_tasks(ctx['root'], [ctx['slug']])[0]
        chk('task audit', r['ok'], '; '.join(r['problems']))
    out(checks)
    return 0 if all(c['ok'] for c in checks) else 1


# ------------------------------------------------------------------ parser

def build_parser():
    p = argparse.ArgumentParser(prog='viewer.py', description='Monitor Claude Code sessions (read-only, loopback only).')
    sub = p.add_subparsers(dest='cmd')

    def common(sp, task=False, port=False):
        sp.add_argument('--repo', default='.', help='repository root (default: current directory)')
        sp.add_argument('--root', help='tasks root override (default: <repo>/.claude/monitor/tasks)')
        sp.add_argument('--config', help='legacy flat config file (no task workspace)')
        if task:
            sp.add_argument('--task', help='task slug')
        if port:
            sp.add_argument('--port', type=int)
            sp.add_argument('--open', action='store_true')

    sp = sub.add_parser('discover'); common(sp); sp.set_defaults(fn=cmd_discover)
    sp = sub.add_parser('init-task'); common(sp); sp.add_argument('--name', required=True); sp.add_argument('--slug'); sp.add_argument('--description'); sp.set_defaults(fn=cmd_init)
    sp = sub.add_parser('inspect'); common(sp, True); sp.set_defaults(fn=cmd_inspect)
    sp = sub.add_parser('configure'); common(sp, True)
    sp.add_argument('--set', action='append', metavar='KEY=JSON', help='dotted key, JSON value (repeatable)')
    sp.add_argument('--unset', action='append', metavar='KEY'); sp.add_argument('--reason'); sp.add_argument('--decision'); sp.set_defaults(fn=cmd_configure)
    sp = sub.add_parser('decide'); common(sp, True); sp.add_argument('--title', required=True); sp.add_argument('--decision', required=True); sp.add_argument('--rejected'); sp.set_defaults(fn=cmd_decide)
    sp = sub.add_parser('audit'); common(sp, True); sp.set_defaults(fn=cmd_audit)
    sp = sub.add_parser('check'); common(sp, True); sp.set_defaults(fn=cmd_check)
    sp = sub.add_parser('start'); common(sp, True, True); sp.set_defaults(fn=cmd_start)
    sp = sub.add_parser('serve'); common(sp, True, True); sp.add_argument('--state-file'); sp.set_defaults(fn=cmd_serve)
    sp = sub.add_parser('restart'); common(sp, True, True); sp.set_defaults(fn=cmd_restart)
    sp = sub.add_parser('verify'); common(sp, True); sp.set_defaults(fn=cmd_verify)
    sp = sub.add_parser('status'); common(sp, True); sp.set_defaults(fn=cmd_status)
    sp = sub.add_parser('stop'); common(sp, True); sp.set_defaults(fn=cmd_stop)
    sp = sub.add_parser('doctor'); common(sp, True); sp.set_defaults(fn=cmd_doctor)
    return p


def legacy_args(argv):
    """v1 flags: --config FILE [--port N] [--open] | --discover [--repo P] | --config FILE --check | --config FILE --stop."""
    ap = argparse.ArgumentParser()
    ap.add_argument('--config'); ap.add_argument('--port', type=int); ap.add_argument('--open', action='store_true')
    ap.add_argument('--discover', action='store_true'); ap.add_argument('--check', action='store_true'); ap.add_argument('--stop', action='store_true')
    ap.add_argument('--repo', default='.')
    a = ap.parse_args(argv)
    a.root, a.task, a.state_file = None, None, None
    if a.discover:
        return cmd_discover, a
    if a.stop:
        return (cmd_stop if a.config else (lambda _a: fail('--stop needs --config FILE', 2))), a
    if a.check:
        return cmd_check, a
    return cmd_serve, a


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv and not argv[0].startswith('-'):
            a = build_parser().parse_args(argv)
            if not getattr(a, 'fn', None):
                build_parser().print_help()
                return 2
            if a.cmd in ('start', 'serve', 'verify', 'status', 'stop', 'check') and not getattr(a, 'task', None) and not a.config:
                pass        # defaults-only monitor on the current repo is allowed
            return a.fn(a)
        fn, a = legacy_args(argv)
        return fn(a)
    except (C.ConfigError, OSError) as e:
        return fail(str(e))

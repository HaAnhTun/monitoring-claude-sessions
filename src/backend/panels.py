"""Optional side panels: machine load, git, live log tails, ledger, chain log and the attempts table."""
import csv, ctypes, glob, os, re, subprocess, time

from . import proc, sessions, state


def repo_path(cfg):
    return os.path.abspath(cfg['repo'])


def rel(cfg, p):
    return p if os.path.isabs(p) else os.path.join(repo_path(cfg), p)


def tail_lines(path, n):
    """Last n lines of a text file without reading all of it."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max(65536, n * 400)))
            data = f.read()
        return data.decode('utf-8', errors='replace').splitlines()[-n:]
    except OSError:
        return []


# ---------------------------------------------------------------- attempts

def attempts_rows(cfg, base_sessions):
    """Rows of the attempts table built from the chain log; sessions are matched by label and start time."""
    acfg = cfg.get('attempts')
    if not acfg or not cfg.get('chain_log'):
        return []
    fmt = acfg.get('time_format', '%Y-%m-%d %H:%M:%S')
    start_re, end_re = re.compile(acfg['start']), re.compile(acfg['end'])
    prefix = acfg.get('label_prefix', '')
    cands = [s for s in base_sessions if s['label'].startswith(prefix)]
    rows, open_ = [], {}
    for line in tail_lines(rel(cfg, cfg['chain_log']), 4000):
        m = start_re.match(line)
        if m:
            g = m.groupdict()
            try:
                t0 = time.mktime(time.strptime(g['time'], fmt))
            except (KeyError, ValueError):
                continue
            row = {'part': g.get('part', ''), 'n': g.get('n', ''), 'model': g.get('model') or '', 'effort': g.get('effort') or '',
                   'start': t0, 'end': None, 'exit': None, 'status': None, 'sid': None}
            rows.append(row)
            open_[row['part']] = row
            continue
        m = end_re.match(line)
        if m and m.groupdict().get('part') in open_:
            g = m.groupdict()
            row = open_.pop(g['part'])
            try:
                row['end'] = time.mktime(time.strptime(g['time'], fmt))
            except (KeyError, ValueError):
                row['end'] = row['start']
            row['exit'], row['status'] = g.get('exit'), g.get('status')
    for row in rows:
        best = None
        for s in cands:
            if s['label'] != prefix + row['part'] or not s['first_epoch']:
                continue
            d = s['first_epoch'] - row['start']
            if -15 <= d <= 600 and (best is None or d < best[0]):
                best = (d, s)
        if best:
            row['sid'], row['usage_total'] = best[1]['id'], best[1]['usage_total']
        ext = state.external_state(row)
        row['state'] = ext['state'] if ext else ('RUNNING' if row['end'] is None else 'UNKNOWN')
    return rows[-30:]


def external_map(rows):
    """session id -> external state evidence, from the attempts rows that ended."""
    out = {}
    for r in rows:
        ext = state.external_state(r) if r.get('sid') else None
        if ext:
            out[r['sid']] = ext
    return out


# ---------------------------------------------------------------- machine

class MEMSTAT(ctypes.Structure):
    _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('sullAvailExtendedVirtual', ctypes.c_ulonglong)]


CPU, DOCKER = {}, {'t': 0, 'v': []}


def cpu_pct_windows():
    from ctypes import wintypes
    idle, kern, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    f = lambda x: (x.dwHighDateTime << 32) | x.dwLowDateTime
    cur, prev = (f(idle), f(kern), f(user)), CPU.get('p')
    CPU['p'] = cur
    if not prev:
        return None
    di, dk, du = cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]
    return int(round(100.0 * (dk + du - di) / (dk + du))) if dk + du > 0 else None


def machine(cfg):
    procs, free, total, used, cpu = {}, 0.0, 0.0, 0, None
    watched = {w.lower() for w in cfg['watched_processes']}
    if os.name == 'nt':
        s = MEMSTAT()
        s.dwLength = ctypes.sizeof(MEMSTAT)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
        free, total, used, cpu = s.ullAvailPhys / 1073741824, s.ullTotalPhys / 1073741824, int(s.dwMemoryLoad), cpu_pct_windows()
        try:
            out = proc.run(['tasklist', '/fo', 'csv', '/nh'], capture_output=True, text=True, timeout=10).stdout
            for row in csv.reader(out.splitlines()):
                if len(row) >= 5 and row[0].lower() in watched:
                    d = procs.setdefault(row[0], {'name': row[0], 'count': 0, 'mb': 0})
                    d['count'] += 1
                    d['mb'] += int(re.sub(r'[^0-9]', '', row[4]) or 0) // 1024
        except Exception:
            pass
    else:  # best effort on Linux and macOS (not verified on those systems)
        try:
            with open('/proc/meminfo') as f:
                mem = {k: int(v.split()[0]) for k, v in (l.split(':', 1) for l in f.read().splitlines())}
            free, total = mem['MemAvailable'] / 1048576, mem['MemTotal'] / 1048576
            used = int(100 * (1 - mem['MemAvailable'] / mem['MemTotal']))
        except Exception:
            pass
        try:
            for line in proc.run(['ps', '-eo', 'comm,rss'], capture_output=True, text=True, timeout=10).stdout.splitlines()[1:]:
                name, _, rss = line.strip().rpartition(' ')
                base = os.path.basename(name.strip())
                if base.lower() in watched:
                    d = procs.setdefault(base, {'name': base, 'count': 0, 'mb': 0})
                    d['count'] += 1
                    d['mb'] += int(rss or 0) // 1024
        except Exception:
            pass
    if cfg['docker'] and time.time() - DOCKER['t'] > 10:
        try:
            o = proc.run(['docker', 'ps', '--format', '{{.Names}} ({{.Status}})'], capture_output=True, text=True, timeout=8).stdout
            DOCKER['v'] = [l for l in o.splitlines() if l.strip()]
        except Exception:
            DOCKER['v'] = ['(docker unavailable)']
        DOCKER['t'] = time.time()
    return {'free_gb': round(free, 2), 'total_gb': round(total, 1), 'used_pct': used, 'cpu_pct': cpu,
            'procs': sorted(procs.values(), key=lambda d: -d['mb']), 'docker': DOCKER['v'] if cfg['docker'] else [], 'now': time.time()}


# ---------------------------------------------------------------- logs, git, overview

def live_logs(cfg):
    files = []
    for pat in cfg['live_log_globs']:
        files += glob.glob(pat if os.path.isabs(pat) else os.path.join(repo_path(cfg), pat))
    files = sorted(set(files), key=os.path.getmtime, reverse=True)[:4]
    now = time.time()
    return [{'name': os.path.basename(p), 'age': int(now - os.path.getmtime(p)), 'size': os.path.getsize(p),
             'tail': [l[:220] for l in tail_lines(p, 16)] if i < 2 else []} for i, p in enumerate(files)]


def git(cfg, *a):
    try:
        return proc.run(['git'] + list(a), capture_output=True, text=True, timeout=10, cwd=repo_path(cfg)).stdout.strip()
    except Exception:
        return ''


def overview(cfg):
    ledger = [l for l in tail_lines(rel(cfg, cfg['ledger']), 30) if l.startswith('|')] if cfg['ledger'] and cfg['panels'].get('ledger') else []
    chain = tail_lines(rel(cfg, cfg['chain_log']), 10) if cfg['chain_log'] and cfg['panels'].get('chain_log') else []
    g = cfg['panels'].get('git')
    return {'ledger': ledger, 'chain': chain,
            'branch': git(cfg, 'branch', '--show-current') if g else '',
            'commits': git(cfg, 'log', '--format=%h %ad %s', '--date=format:%H:%M', '-3').splitlines() if g else [],
            'dirty': len(git(cfg, 'status', '--short').splitlines()) if g else 0,
            'stop': bool(cfg['stop_file'] and os.path.exists(rel(cfg, cfg['stop_file']))), 'now': time.time()}

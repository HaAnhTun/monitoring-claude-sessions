"""Session execution state, derived from evidence and kept separate from monitor health and data freshness.

States: RUNNING, IDLE, COMPLETED, FAILED, UNKNOWN (rules in docs/api.md). A transcript alone can never prove that a
job finished or failed, so COMPLETED and FAILED need external evidence (attempts table); a failed poll is never FAILED.
"""
import ctypes, glob, json, os, re

PASS_RE = re.compile(r'^\s*(PASS|DONE|OK|COMPLETE[D]?|SUCCESS)', re.I)
FAIL_RE = re.compile(r'(FAIL|BLOCK|ERROR|ABORT)', re.I)
END_STOPS = ('end_turn', 'stop_sequence')


def classify_state(now, mtime, active_seconds, last_stop, pending, oldest_pending_ts, agent_mtimes, grace_seconds,
                   registry=None, external=None, has_records=True):
    """Returns (state, evidence, source). Pure function; every argument is evidence gathered by the caller.
    mtime/agent_mtimes are epoch seconds, oldest_pending_ts is epoch seconds of the oldest tool call without result."""
    if external:
        return external['state'], external['evidence'], 'external'
    if not has_records:
        return 'UNKNOWN', 'no readable records', 'transcript'
    age = now - mtime
    if registry and registry.get('status') == 'busy':
        return 'RUNNING', 'Claude session registry reports busy', 'registry'
    if age < active_seconds:
        return 'RUNNING', 'transcript written %ds ago' % age, 'transcript'
    recent_agent = [a for a in agent_mtimes if now - a < 60]
    if recent_agent:
        return 'RUNNING', '%d subagent(s) written within the last minute' % len(recent_agent), 'transcript'
    if pending:
        waited = now - oldest_pending_ts if oldest_pending_ts else age
        if waited < grace_seconds:
            return 'RUNNING', '%d tool call(s) without result for %ds (within the %ds grace)' % (pending, waited, grace_seconds), 'transcript'
        return 'UNKNOWN', '%d tool call(s) without result for %dm: stalled, killed, waiting for permission or a very long tool' % (pending, waited // 60), 'transcript'
    if registry and registry.get('status') == 'idle':
        return 'IDLE', 'Claude session registry reports idle; quiet %dm' % (age // 60), 'registry'
    if last_stop in END_STOPS:
        return 'IDLE', 'turn ended (%s), quiet %dm; the transcript cannot show whether the job is finished or waiting' % (last_stop, age // 60), 'transcript'
    return 'UNKNOWN', 'quiet %dm and the last stop reason is %r' % (age // 60, last_stop or 'missing'), 'transcript'


def external_state(row):
    """Evidence from one attempts-table row ({end, exit, status}); None while still running or unknown."""
    if row is None:
        return None
    if row.get('end') is None:
        return None            # still open in the chain log: let the transcript decide (usually RUNNING)
    status, code = row.get('status') or '', row.get('exit')
    nonzero = code not in (None, '', '0', 0)
    if nonzero or FAIL_RE.search(status):
        return {'state': 'FAILED', 'evidence': 'chain log: exit=%s status=%s' % (code, status.strip() or '-')}
    if PASS_RE.match(status) or (not status.strip() and code in ('0', 0)):
        return {'state': 'COMPLETED', 'evidence': 'chain log: exit=%s status=%s' % (code, status.strip() or '-')}
    return {'state': 'UNKNOWN', 'evidence': 'chain log: the run ended (exit=%s) but its status %r is neither a pass nor a failure' % (code, status.strip())}


# ---- Claude session registry (~/.claude/sessions/<pid>.json): optional liveness evidence for interactive sessions

def claude_home():
    return os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.claude')


def pid_alive(pid):
    """True when a process with this pid exists. Never signals the process (os.kill(pid, 0) would kill it on Windows)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == 'nt':
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)       # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259     # STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def registry():
    """sessionId -> {status, pid, kind} for registry files whose process is still alive."""
    out = {}
    for p in glob.glob(os.path.join(claude_home(), 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        sid = d.get('sessionId')
        if isinstance(sid, str) and d.get('status') in ('busy', 'idle') and pid_alive(d.get('pid')):
            out[sid] = {'status': d['status'], 'pid': d.get('pid'), 'kind': d.get('kind')}
    return out

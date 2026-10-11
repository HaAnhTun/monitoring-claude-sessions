"""Determinism controls of the golden capture (design 06 section 5.2.3, ADR 0053).

Everything that makes the legacy engine's output vary between runs is pinned here, without touching a legacy file:
the wall clock (`time.time`), `datetime.now` in the modules that call it, `uuid.uuid4`, file mtimes that no builder
set, the local time zone, and every machine-specific spelling (temp directory, pid) that would leak into a golden.
Python standard library only; imported by `capture_golden.py` after it has made sure that no bytecode is written.
"""
import contextlib
import ctypes
import datetime
import hashlib
import json
import os
import re
import sys
import time
import types
import uuid

FROZEN_NOW = 1790000000  # 2026-09-21T14:13:20Z; no DST transition in any zone within +-2 days of it

# Windows' C runtime ignores IANA names (it silently falls back to the machine zone), so zones that the capture may be
# asked for are mapped to POSIX strings with a fixed offset. Value: (TZ value for the C runtime, offset east of UTC in seconds).
FIXED_ZONES = {
    'UTC': ('UTC', 0),
    'Etc/UTC': ('UTC', 0),
    'GMT': ('UTC', 0),
    'Asia/Ho_Chi_Minh': ('ICT-7', 7 * 3600),
    'Asia/Saigon': ('ICT-7', 7 * 3600),
    'Asia/Bangkok': ('ICT-7', 7 * 3600),
    'Asia/Tokyo': ('JST-9', 9 * 3600),
    'Asia/Kolkata': ('IST-5:30', 5 * 3600 + 1800),
}

_clock = [float(FROZEN_NOW)]
_uuid_counter = [0]
_RealDT = datetime.datetime


# ---- time zone ---------------------------------------------------------------------------------------------------------

def tz_env_value(tz):
    """The TZ environment value that makes this process use `tz`, or raises ValueError when the platform cannot honour it."""
    if os.name == 'nt':
        if tz not in FIXED_ZONES:
            raise ValueError('time zone %r is not supported on Windows (supported: %s)' % (tz, ', '.join(sorted(FIXED_ZONES))))
        return FIXED_ZONES[tz][0]
    return tz


def verify_tz(tz):
    """Fail loudly when the C runtime did not take the zone (a silent fallback to the machine zone would corrupt every golden)."""
    if tz not in FIXED_ZONES:
        return
    east = int(FROZEN_NOW - time.mktime(time.gmtime(FROZEN_NOW)))
    if east != FIXED_ZONES[tz][1]:
        raise RuntimeError('time zone %s requested but the local offset is %+d s (expected %+d s)' % (tz, east, FIXED_ZONES[tz][1]))


# ---- frozen clock, seeded uuids, datetime shim ---------------------------------------------------------------------------

def _frozen_time():
    return _clock[0]


class FrozenDT(_RealDT):
    """`datetime.datetime` whose `now()` is the frozen clock (the real class everywhere else)."""

    @classmethod
    def now(cls, tz=None):
        return _RealDT.fromtimestamp(_clock[0], tz) if tz is not None else _RealDT.fromtimestamp(_clock[0])


class DatetimeShim(types.SimpleNamespace):
    """Stand-in for the `datetime` module attribute of the legacy modules that call `datetime.datetime.now`."""


SHIM = DatetimeShim(datetime=FrozenDT, timezone=datetime.timezone, timedelta=datetime.timedelta)


def det_uuid(n):
    return uuid.UUID('%08x-0000-4000-8000-%012x' % (n, n))


def _next_uuid():
    _uuid_counter[0] += 1
    return det_uuid(_uuid_counter[0])


def reset_uuids():
    """Every scenario restarts the draw order at 1, so a scenario can be rebuilt (and rebuilt from TypeScript) on its own."""
    _uuid_counter[0] = 0


def draws():
    return _uuid_counter[0]


@contextlib.contextmanager
def clock_at(epoch):
    """Run a block with the frozen clock moved to `epoch` (used by vectors that need several distinct timestamps)."""
    old = _clock[0]
    _clock[0] = float(epoch)
    try:
        yield
    finally:
        _clock[0] = old


def install():
    """Replace the three sources of wall-clock and random variation. Called once, before any legacy module is imported."""
    time.time = _frozen_time
    uuid.uuid4 = _next_uuid


def load_legacy(skill_dir):
    """Import the legacy engine read-only (sys.dont_write_bytecode must already be true) and inject the shims.
    Returns a namespace with the modules the capture needs. Nothing on disk is patched."""
    if not sys.dont_write_bytecode:
        raise RuntimeError('bytecode writing is enabled: refusing to import legacy code (would create __pycache__ in the skill tree)')
    for sub in (('src',), ('tests', 'fixtures'), ('tests', 'tools')):
        p = os.path.join(skill_dir, *sub)
        if p not in sys.path:
            sys.path.insert(0, p)
    install()
    import make  # noqa: E402  (tests/fixtures/make.py)
    import demo  # noqa: E402  (tests/tools/demo.py)
    make.datetime = SHIM
    demo.datetime = SHIM
    demo.NOW = FrozenDT.now(datetime.timezone.utc)
    import backend  # noqa: E402
    from backend import cli, config, panels, reader, server, sessions, state, tasks  # noqa: E402
    tasks.datetime = SHIM
    return types.SimpleNamespace(make=make, demo=demo, backend=backend, cli=cli, C=config, panels=panels, reader=reader, server=server,
                                 sessions=sessions, state=state, tasks=tasks)


def freeze_untouched(root):
    """Files that no builder aged keep the real wall-clock mtime: pin every mtime later than FROZEN_NOW to FROZEN_NOW."""
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            if os.path.getmtime(p) > FROZEN_NOW:
                os.utime(p, (FROZEN_NOW, FROZEN_NOW))


def set_age(path, seconds):
    """mtime = FROZEN_NOW - seconds (the same rule as make.age under the frozen clock)."""
    t = FROZEN_NOW - seconds
    os.utime(path, (t, t))


# ---- normalisation of machine-specific spellings ---------------------------------------------------------------------------

def _path_spellings(path):
    """The short (8.3) and long spelling of an existing path on Windows, plus the plain and real-path spellings."""
    out = {path, os.path.abspath(path), os.path.realpath(path)}
    if os.name == 'nt':
        k = ctypes.windll.kernel32
        for fn in (k.GetLongPathNameW, k.GetShortPathNameW):
            for p in list(out):
                buf = ctypes.create_unicode_buffer(32768)
                if fn(p, buf, 32768):
                    out.add(buf.value)
    return out


class Normalizer:
    """Replaces every spelling of the capture's temp directories with `<TMP>` (raw, JSON-escaped once and twice, `/` form),
    longest first, case-insensitively on Windows, and the pid of this process in registry files."""

    def __init__(self, *roots):
        forms = set()
        for root in roots:
            for sp in _path_spellings(root):
                forms.update({sp, sp.replace('\\', '/')})
                for ascii_only in (True, False):
                    once = _json_escape(sp, ascii_only)
                    forms.update({once, _json_escape(once, ascii_only)})
        forms.discard('')
        ordered = sorted(forms, key=len, reverse=True)
        flags = re.IGNORECASE if os.name == 'nt' else 0
        self._re = re.compile('|'.join(re.escape(f) for f in ordered), flags) if ordered else None
        self._re_b = re.compile(b'|'.join(re.escape(f.encode('utf-8')) for f in ordered), flags) if ordered else None
        self._pid_b = re.compile(rb'("pid": )%d\b' % os.getpid())

    def text(self, s):
        return self._re.sub('<TMP>', s) if self._re else s

    def value(self, o):
        """Normalise every string (and key) inside a JSON-like value."""
        if isinstance(o, str):
            return self.text(o)
        if isinstance(o, list):
            return [self.value(x) for x in o]
        if isinstance(o, dict):
            return {self.text(k) if isinstance(k, str) else k: self.value(v) for k, v in o.items()}
        return o

    def data(self, b, registry_file=False):
        """Normalise file bytes for a tree manifest; registry files also lose this process's pid."""
        b = self._re_b.sub(b'<TMP>', b) if self._re_b else b
        return self._pid_b.sub(rb'\1"<PID>"', b) if registry_file else b


def _json_escape(s, ascii_only):
    return json.dumps(s, ensure_ascii=ascii_only)[1:-1]


def machine_scrub(o, keys):
    """Replace the values of the given keys anywhere inside a JSON-like value: {key: placeholder}."""
    if isinstance(o, list):
        return [machine_scrub(x, keys) for x in o]
    if isinstance(o, dict):
        return {k: (keys[k] if k in keys else machine_scrub(v, keys)) for k, v in o.items()}
    return o


# ---- tree manifest -----------------------------------------------------------------------------------------------------

def manifest(root, norm):
    """[{path, size, sha256, age_s}] sorted by path; size and hash are those of the normalised content."""
    rows = []
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            with open(p, 'rb') as fh:
                b = norm.data(fh.read(), registry_file=rel.startswith('home/sessions/') or rel.startswith('sessions/'))
            rows.append({'path': rel, 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest(),
                         'age_s': round(FROZEN_NOW - os.path.getmtime(p), 3)})
    return sorted(rows, key=lambda r: r['path'])

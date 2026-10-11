"""Incremental, defensive transcript reader.

One TranscriptReader per .jsonl file keeps checkpoints between polls, so a poll only parses the bytes appended since
the last one. It handles files that grow while read, partial last lines, invalid lines, truncation and replacement
(detected by a fingerprint of the first bytes), unknown record types and missing fields.

Two cursors: the *events* cursor starts at the last event_window bytes of a big file (so something shows at once) and
the *usage* cursor starts at byte 0 and advances within a time budget per poll, so token totals are exact when the scan
completes and are reported as partial (a lower bound) until then.
"""
import hashlib, json, os, threading, time

KNOWN_TYPES = {'user', 'assistant', 'system', 'summary', 'attachment', 'queue-operation', 'last-prompt', 'file-history-snapshot',
               'progress', 'custom-title', 'agent-name', 'permission-mode', 'ai-title', 'pr-link'}
CHUNK = 4 * 1024 * 1024
MAX_LINE = 64 * 1024 * 1024        # a single record longer than this is skipped as invalid


def clip(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + ' ... [truncated %d chars]' % (len(s) - n)


def events_of(r, text_chars=6000):
    """Normalise one transcript record into timeline events."""
    out, t, typ = [], r.get('timestamp') or '', r.get('type')
    msg = r.get('message')
    c = msg.get('content') if isinstance(msg, dict) else None
    if typ == 'user':
        if isinstance(c, str):
            out.append({'t': t, 'k': 'prompt', 'text': clip(c, text_chars)})
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text':
                    out.append({'t': t, 'k': 'prompt', 'text': clip(b.get('text', ''), text_chars)})
                elif b.get('type') == 'tool_result':
                    cc = b.get('content')
                    if isinstance(cc, list):
                        cc = '\n'.join(x.get('text', '') for x in cc if isinstance(x, dict))
                    out.append({'t': t, 'k': 'result', 'id': b.get('tool_use_id'), 'text': clip(cc or '', text_chars), 'err': bool(b.get('is_error'))})
    elif typ == 'assistant' and isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            bt = b.get('type')
            if bt == 'text' and isinstance(b.get('text'), str) and b['text'].strip():
                out.append({'t': t, 'k': 'say', 'text': clip(b['text'], text_chars)})
            elif bt == 'tool_use':
                inp = b.get('input') if isinstance(b.get('input'), dict) else {}
                key = inp.get('command') or inp.get('file_path') or inp.get('pattern') or inp.get('description') or inp.get('prompt') or inp.get('script') or ''
                out.append({'t': t, 'k': 'tool', 'id': b.get('id'), 'name': b.get('name') or '?', 'summary': clip(str(key).split('\n')[0], 160), 'input': clip(inp, 4000)})
            elif bt == 'thinking' and b.get('thinking'):
                out.append({'t': t, 'k': 'think', 'text': clip(b['thinking'], 1500)})
    return out


class TranscriptReader:
    def __init__(self, path, window_bytes=8 << 20, max_events=20000, text_chars=6000, usage_max_bytes=512 << 20, budget_s=1.5):
        self.path, self.window, self.max_events, self.text_chars = path, window_bytes, max_events, text_chars
        self.usage_max, self.budget = usage_max_bytes, budget_s
        self.lock = threading.RLock()
        self.reset()

    # -- state -----------------------------------------------------------
    def reset(self):
        self.head = None                   # first bytes of the file: replacement detector
        self.tail = 0                      # bytes of an unterminated last line (a writer mid-line)
        self.size = 0
        self.mtime = 0.0
        self.events, self.base, self.total = [], 0, 0
        self.eoff = self.uoff = 0          # events cursor, usage cursor (byte offsets of the next unread line)
        self.events_start = 0              # byte where event parsing began (>0: older history not loaded)
        self.msgs, self.models = {}, set()
        self.first = self.last = ''
        self.last_asst, self.last_stop, self.last_kind, self.last_type = None, '', '', ''
        self.pending = {}                  # tool id -> iso timestamp of its tool_use
        self.inv_events = self.inv_pre = 0   # invalid lines seen by the events cursor / only by the usage cursor (before the window)
        self.unknown_records = 0
        self.usage_state = 'complete'      # complete | partial | unavailable
        self.unreadable = False
        self.dropped = 0                   # events dropped by the in-memory cap
        self.started = False
        self.keep = getattr(self, 'keep', False)   # hold events in memory only for transcripts somebody looks at
        self.last_used = time.time()

    @property
    def invalid_lines(self):
        return self.inv_events + self.inv_pre

    # -- public ----------------------------------------------------------
    def want_events(self):
        """Start holding events in memory (the first call re-reads the event window; list-only readers keep no events)."""
        with self.lock:
            if self.keep:
                return self.refresh()
            first = not self.started
            self.keep = True
            self.refresh()
            if first:
                return self
            self.events, self.base, self.total, self.dropped = [], 0, 0, 0
            self.pending, self.inv_events, self.unknown_records = {}, 0, 0
            self.eoff = self.events_start
            self._scan()
            return self

    def refresh(self):
        with self.lock:
            self.last_used = time.time()
            try:
                size = os.path.getsize(self.path)
                cur = self._head_bytes()
                mtime = os.path.getmtime(self.path)
            except OSError:
                self.unreadable = True
                return self
            self.unreadable = False
            if self.started:
                h = self.head or b''
                if size < self.eoff or size < self.uoff or len(cur) < len(h) or cur[:len(h)] != h:
                    self.reset()      # truncated or replaced: start over, never mix two files
            if self.head is None or len(cur) > len(self.head):
                self.head = cur
            self.size, self.mtime = size, mtime
            if not self.started:
                self.started = True
                self.events_start = self._line_start(max(0, size - self.window)) if size > self.window else 0
                self.eoff = self.events_start
                if size > self.usage_max:
                    self.usage_state, self.uoff = 'unavailable', size
            self._scan()
            return self

    def usage(self):
        with self.lock:
            tot = {'in': 0, 'out': 0, 'cr': 0, 'cc': 0}
            for v in self.msgs.values():
                for k in tot:
                    tot[k] += v[k]
            eff = max(0, self.size - self.tail)
            pct = 100 if eff == 0 else min(100, int(100 * self.uoff / eff))
            complete = self.usage_state == 'complete'
            tot.update({'turns': len(self.msgs), 'models': sorted(self.models), 'first': self.first, 'last': self.last,
                        'stop': self.last_stop, 'complete': complete, 'scanned_pct': pct if self.usage_state != 'unavailable' else 0})
            if self.usage_state == 'unavailable':
                tot['skipped'] = True
            return tot

    def completeness(self):
        with self.lock:
            partial = self.events_start > 0 or self.dropped > 0
            return {'events': 'partial' if partial else 'full', 'events_skipped_bytes': self.events_start, 'events_dropped': self.dropped,
                    'usage': self.usage_state, 'usage_scanned_pct': self.usage()['scanned_pct'], 'invalid_lines': self.invalid_lines}

    def slice(self, start, limit=None):
        """Events with absolute index >= start (clamped to what is held)."""
        with self.lock:
            s = max(start, self.base) - self.base
            part = self.events[s:] if limit is None else self.events[s:s + limit]
            return part

    # -- internals -------------------------------------------------------
    def _head_bytes(self):
        with open(self.path, 'rb') as f:
            return f.read(256)

    def _line_start(self, pos):
        """Align pos forward to the start of a line (the line containing pos is only partly inside the window)."""
        if pos <= 0:
            return 0
        try:
            with open(self.path, 'rb') as f:
                f.seek(pos - 1)
                at = pos - 1
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        return self.size
                    i = chunk.find(b'\n')
                    if i >= 0:
                        return at + i + 1
                    at += len(chunk)
        except OSError:
            return pos

    def _read_lines(self, start, stop):
        """Complete lines in [start, stop). The window grows until a newline is found, so records longer than a chunk
        still parse. An unterminated tail is returned only when it is already valid JSON. Returns (lines, used, tail)."""
        want = min(CHUNK, stop - start)
        while True:
            with open(self.path, 'rb') as f:
                f.seek(start)
                data = f.read(want)
            if b'\n' in data or start + len(data) >= stop or want >= MAX_LINE:
                break
            want = min(want * 4, MAX_LINE, stop - start)
        out, pos, n = [], 0, len(data)
        while pos < n:
            nl = data.find(b'\n', pos)
            if nl < 0:
                rest = data[pos:]
                if start + n >= stop and rest.strip():
                    try:
                        json.loads(rest)
                        out.append((start + pos, len(rest), rest))
                        pos = n
                    except ValueError:
                        pass
                elif start + n < stop and want >= MAX_LINE:
                    self.inv_events += 1          # an oversized record: skip it
                    pos = n
                break
            out.append((start + pos, nl + 1 - pos, data[pos:nl]))
            pos = nl + 1
        return out, pos, (n - pos if start + n >= stop else 0)

    def _scan(self):
        t0 = time.time()
        # events cursor first: the freshest part of the file matters most
        while self.eoff < self.size:
            lines, used, tail = self._read_lines(self.eoff, self.size)
            self.tail = tail
            if used == 0:
                break
            for pos, ln, raw in lines:
                self._record(pos, raw, events=True, usage=(self.uoff == pos))
                if self.uoff == pos:
                    self.uoff = pos + ln
            self.eoff += used
            if time.time() - t0 > self.budget * 2:
                break
        if self.eoff >= self.size:
            self.tail = self.size - self.eoff
        # usage cursor: catch up from byte 0 within the time budget
        t1 = time.time()
        while self.uoff < self.eoff and self.usage_state != 'unavailable':
            lines, used, _ = self._read_lines(self.uoff, self.eoff)
            if used == 0:
                break
            for pos, ln, raw in lines:
                self._record(pos, raw, events=False, usage=True)
            self.uoff += used
            if time.time() - t1 > self.budget:
                break
        if self.usage_state != 'unavailable':
            self.usage_state = 'complete' if self.uoff >= self.size - self.tail else 'partial'

    def _record(self, pos, raw, events, usage):
        try:
            r = json.loads(raw)
            if not isinstance(r, dict):
                raise ValueError
        except ValueError:
            if raw.strip():
                if events:
                    self.inv_events += 1
                elif pos < self.events_start:
                    self.inv_pre += 1
            return
        typ = r.get('type')
        if events and typ not in KNOWN_TYPES:
            self.unknown_records += 1
        ts = r.get('timestamp')
        if isinstance(ts, str) and ts:
            if usage and not self.first:
                self.first = ts
            if not self.last or ts > self.last:
                self.last = ts
        if usage and typ == 'assistant' and isinstance(r.get('message'), dict):
            m = r['message']
            u = m.get('usage') if isinstance(m.get('usage'), dict) else {}
            cur = self.msgs.setdefault(m.get('id') or r.get('uuid') or ('line%d' % pos), {'in': 0, 'out': 0, 'cr': 0, 'cc': 0})
            for k, f in (('in', 'input_tokens'), ('out', 'output_tokens'), ('cr', 'cache_read_input_tokens'), ('cc', 'cache_creation_input_tokens')):
                v = u.get(f)
                if isinstance(v, int) and v > cur[k]:
                    cur[k] = v
            if m.get('model'):
                self.models.add(m['model'])
        if events:
            if typ == 'assistant':
                m = r.get('message') if isinstance(r.get('message'), dict) else {}
                mid = m.get('id') or r.get('uuid')
                if mid != self.last_asst:
                    self.last_asst, self.last_stop = mid, ''
                if m.get('stop_reason'):
                    self.last_stop = m['stop_reason']
            if typ in ('user', 'assistant'):
                self.last_type = typ
            for ev in events_of(r, self.text_chars):
                ev['i'] = self.total
                self.total += 1
                if self.keep:
                    self.events.append(ev)
                self.last_kind = ev['k']
                if ev['k'] == 'tool' and ev.get('id'):
                    self.pending[ev['id']] = ev['t']
                elif ev['k'] == 'result':
                    self.pending.pop(ev.get('id'), None)
            over = len(self.events) - self.max_events
            if self.keep and over > 0:
                del self.events[:over]
                self.base += over
                self.dropped += over


class ReaderPool:
    """One reader per path, created on demand; settings come from the effective config limits."""

    def __init__(self, limits):
        self.limits = limits
        self.readers = {}
        self.lock = threading.Lock()

    def get(self, path):
        with self.lock:
            r = self.readers.get(path)
            if r is None:
                lim = self.limits
                r = self.readers[path] = TranscriptReader(
                    path, int(lim['event_window_mb'] * 1048576), int(lim['max_events']), int(lim['text_chars']),
                    int(lim['usage_max_mb'] * 1048576), lim['usage_scan_budget_ms'] / 1000.0)
        return r.refresh()

    def get_events(self, path):
        return self.get(path).want_events()

    def prune(self, max_idle=1800):
        """Forget readers nobody asked for lately (sessions that left the window), freeing their memory."""
        cut = time.time() - max_idle
        with self.lock:
            for p in [p for p, r in self.readers.items() if r.last_used < cut]:
                del self.readers[p]

    def stats(self):
        with self.lock:
            rs = list(self.readers.values())
        return {'files': len(rs), 'invalid_lines': sum(r.invalid_lines for r in rs), 'bytes_scanned': sum(r.uoff for r in rs),
                'unknown_records': sum(r.unknown_records for r in rs)}

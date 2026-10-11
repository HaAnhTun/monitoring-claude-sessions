"""HTTP server: JSON API, static frontend, TTL cache shared by all tabs, health and error ring."""
import collections, http.server, json, os, socketserver, threading, time, urllib.parse

from . import __version__, code_stamp, config as cfgmod, panels, sessions, tasks

FRONTEND = os.path.join(cfgmod.SKILL_DIR, 'src', 'frontend')
STATIC_EXT = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
              '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8'}
LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1')
J = 'application/json'


class Monitor:
    """Everything one running viewer needs: effective config, reader pool, caches, error ring."""

    def __init__(self, cfg, meta):
        from .reader import ReaderPool
        self.cfg, self.meta, self.started = cfg, meta, time.time()
        self.stamp = code_stamp()
        if cfg['transcripts_dir'] in (None, 'auto'):
            cfg['transcripts_dir'] = sessions.detect_transcripts_dir(panels.repo_path(cfg))
        self.pool = ReaderPool(cfg['limits'])
        self.errors = collections.deque(maxlen=20)
        self.ttl, self.locks, self.lock = {}, {}, threading.Lock()

    # -- helpers -----------------------------------------------------------
    def record_error(self, where, message):
        self.errors.append({'t': time.time(), 'where': where, 'message': str(message)[:300]})

    def cached(self, key, ttl, fn):
        """One computation per key per ttl, shared by every open tab (cost does not grow with tab count)."""
        now = time.time()
        e = self.ttl.get(key)
        if e and now - e[0] < ttl:
            return e[1]
        with self.lock:
            lk = self.locks.setdefault(key, threading.Lock())
        with lk:
            e = self.ttl.get(key)
            if e and time.time() - e[0] < ttl:
                return e[1]
            try:
                v = json.dumps(fn())
            except Exception as exc:
                self.record_error(key, exc)
                if e:                 # keep serving the last good value rather than failing every poll
                    return e[1]
                raise
            self.ttl[key] = (time.time(), v)
            return v

    # -- data ---------------------------------------------------------------
    def attempts(self):
        base = sessions.list_sessions(self.cfg, self.pool, 24, False)
        return panels.attempts_rows(self.cfg, base)

    def sessions(self, hours, show_all):
        ext = panels.external_map(json.loads(self.cached('attempts', 4, self.attempts))) if self.cfg.get('attempts') else None
        self.pool.prune()
        return sessions.list_sessions(self.cfg, self.pool, hours, show_all, ext)

    def health(self):
        return {'ok': True, 'version': __version__, 'pid': os.getpid(), 'started': self.started, 'uptime': round(time.time() - self.started, 1),
                'now': time.time(), 'code_stamp': self.stamp, 'task': self.task_brief(), 'config_source': self.meta['source'],
                'transcripts_dir': bool(self.cfg['transcripts_dir']), 'errors': list(self.errors), 'reader': self.pool.stats()}

    def task_brief(self):
        t = self.meta.get('task')
        return {'id': t.get('id'), 'name': t.get('name'), 'description': t.get('description', '')} if t else None

    def config_view(self):
        c = self.cfg
        return {'title': c['title'], 'panels': c['panels'], 'active': c['active_seconds'], 'window_hours': c['window_hours'],
                'transcripts_dir': bool(c['transcripts_dir']), 'version': __version__, 'task': self.task_brief(), 'ui': c['ui'], 'poll': c['poll'],
                'features': {'search': True, 'locate': True}}

    def task_view(self):
        t = self.meta.get('task')
        last = tasks.last_change(os.path.dirname(self.meta['path'])) if t and self.meta.get('path') else None
        return {'task': t, 'config_source': self.meta['source'], 'last_change': last}

    def events(self, rd, q):
        g = lambda k, d='': (q.get(k) or [d])[0]
        total = rd.total
        try:
            after, before, limit = int(g('after', '-1')), g('before'), g('limit')
            limit = max(1, min(int(limit), 2000)) if limit else None
            before = int(before) if before != '' else None
        except ValueError:
            raise ValueError('after, before and limit must be integers')
        if before is not None:
            end = max(rd.base, min(before, total))
            start = max(rd.base, end - (limit or 250))
            ev = rd.slice(start, end - start)
        elif after < 0:
            start = max(rd.base, total - 250)
            ev = rd.slice(start)
        else:
            start = max(rd.base, min(after, total))
            ev = rd.slice(start, limit or 2000)
        comp = rd.completeness()
        return {'total': total, 'from': start, 'base': rd.base, 'next': start + len(ev), 'partial': comp['events'] == 'partial',
                'skipped_bytes': comp['events_skipped_bytes'], 'events': ev}

    def search(self, rd, q):
        g = lambda k, d='': (q.get(k) or [d])[0]
        needle, errors = g('q').lower(), g('errors') == '1'
        kinds = {k for k in g('kinds').split(',') if k}
        tool = g('tool')
        try:
            limit = max(1, min(int(g('limit', '200')), 1000))
        except ValueError:
            raise ValueError('limit must be an integer')
        evs = rd.slice(rd.base)
        names = {e['id']: e.get('name') for e in evs if e['k'] == 'tool' and e.get('id')}
        bad = {e['id'] for e in evs if e['k'] == 'result' and e.get('err')}
        out, count = [], 0
        for e in evs:
            k = e['k']
            if kinds and k not in kinds:
                continue
            if errors and not ((k == 'result' and e.get('err')) or (k == 'tool' and e.get('id') in bad)):
                continue
            if tool and not ((k == 'tool' and e.get('name') == tool) or (k == 'result' and names.get(e.get('id')) == tool)):
                continue
            hay = ' '.join(str(e.get(f, '')) for f in ('text', 'summary', 'input', 'name')).lower()
            pos = hay.find(needle) if needle else 0
            if needle and pos < 0:
                continue
            count += 1
            if len(out) < limit:
                src = e.get('text') or e.get('summary') or e.get('input') or ''
                p = max(0, src.lower().find(needle) - 40) if needle else 0
                m = {'i': e['i'], 'k': k, 't': e['t'], 'snippet': src[p:p + 160]}
                if e.get('name'):
                    m['name'] = e['name']
                out.append(m)
        return {'matches': out, 'count': count, 'truncated': count > len(out), 'partial': rd.completeness()['events'] == 'partial'}

    def locate(self, rd, q):
        g = lambda k, d='': (q.get(k) or [d])[0]
        evs = rd.slice(rd.base)
        if not evs:
            return None
        if g('i') != '':
            idx = max(rd.base, min(int(g('i')), rd.total - 1))
            e = evs[idx - rd.base]
        else:
            ts = g('ts')
            e = next((x for x in evs if x['t'] >= ts), evs[-1])
        return {'i': e['i'], 't': e['t'], 'base': rd.base, 'total': rd.total}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'ClaudeSessionMonitor/' + __version__

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def err(self, code, msg):
        self.send(code, json.dumps({'error': msg}), J)

    def static(self, rel):
        parts = [p for p in rel.replace('\\', '/').split('/') if p]
        ext = os.path.splitext(rel)[1].lower()
        if not parts or any(p.startswith('.') or p == '..' or ':' in p for p in parts) or ext not in STATIC_EXT:
            return self.send(404, 'not found', 'text/plain')
        full = os.path.realpath(os.path.join(FRONTEND, *parts))
        if not full.startswith(os.path.realpath(FRONTEND) + os.sep) or not os.path.isfile(full):
            return self.send(404, 'not found', 'text/plain')
        with open(full, 'rb') as f:
            data = f.read()
        if parts == ['index.html']:
            data = data.replace(b'__TITLE__', self.server.mon.cfg['title'].replace('&', '&amp;').replace('<', '&lt;').encode('utf-8'))
        self.send(200, data, STATIC_EXT[ext])

    def do_GET(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
        if host not in LOCAL_HOSTS:
            self.send(403, 'forbidden host (this viewer only answers on 127.0.0.1 or localhost)', 'text/plain')
            return
        mon = self.server.mon
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        g = lambda k, d='': (q.get(k) or [d])[0]
        hours = g('hours', str(mon.cfg['window_hours']))
        try:
            if u.path in ('/', '/index.html'):
                self.static('index.html')
            elif u.path.startswith('/static/'):
                self.static(urllib.parse.unquote(u.path[len('/static/'):]))
            elif u.path == '/api/health':
                self.send(200, json.dumps(mon.health()), J)
            elif u.path == '/api/config':
                self.send(200, json.dumps(mon.config_view()), J)
            elif u.path == '/api/task':
                self.send(200, json.dumps(mon.task_view()), J)
            elif u.path == '/api/overview':
                self.send(200, mon.cached('overview', 10, lambda: panels.overview(mon.cfg)), J)
            elif u.path == '/api/machine':
                self.send(200, mon.cached('machine', 1.8, lambda: panels.machine(mon.cfg)), J)
            elif u.path == '/api/logs':
                self.send(200, mon.cached('logs', 2, lambda: panels.live_logs(mon.cfg)), J)
            elif u.path == '/api/attempts':
                self.send(200, mon.cached('attempts', 4, mon.attempts), J)
            elif u.path == '/api/sessions':
                try:
                    h = float(hours)
                except ValueError:
                    return self.err(400, 'hours must be a number')
                self.send(200, mon.cached('sessions|%s|%s' % (hours, g('all')), 3, lambda: mon.sessions(h, g('all') == '1')), J)
            elif u.path in ('/api/events', '/api/search', '/api/locate'):
                p = sessions.resolve(mon.cfg, g('sid'), g('agent'))
                if not p:
                    return self.err(404, 'not found')
                rd = mon.pool.get_events(p)
                try:
                    if u.path == '/api/events':
                        self.send(200, json.dumps(mon.events(rd, q)), J)
                    elif u.path == '/api/search':
                        self.send(200, json.dumps(mon.search(rd, q)), J)
                    else:
                        res = mon.locate(rd, q)
                        if res is None:
                            return self.err(404, 'no events')
                        self.send(200, json.dumps(res), J)
                except ValueError as exc:
                    self.err(400, str(exc))
            else:
                self.send(404, 'not found', 'text/plain')
        except Exception as exc:
            mon.record_error(u.path, exc)
            self.err(500, str(exc))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False      # a second viewer on the same port must fail, not share it

    def __init__(self, addr, mon):
        super().__init__(addr, Handler)
        self.mon = mon


def bind(mon, port):
    """Bind 127.0.0.1 on the first free port from `port` (up to +19)."""
    for p in range(port, port + 20):
        try:
            return Server(('127.0.0.1', p), mon), p
        except OSError:
            continue
    return None, port

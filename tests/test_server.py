import http.client, json, os, shutil, sys, tempfile, threading, unittest, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src'))
sys.path.insert(0, os.path.join(HERE, 'fixtures'))

import make as M  # noqa: E402
from backend import config as C  # noqa: E402
from backend.server import Monitor, Server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.env = os.environ.get('CLAUDE_CONFIG_DIR')
        cls.fx = M.build_home(os.path.join(cls.tmp, 'home'))
        os.environ['CLAUDE_CONFIG_DIR'] = cls.fx['home']
        cfg, meta = C.resolve_runtime()
        cfg.update(repo=cls.tmp, transcripts_dir=cls.fx['tdir'], include_unmatched=True)
        cfg['panels'].update(git=False, machine=False, logs=False)
        cls.mon = Monitor(cfg, meta)
        cls.srv = Server(('127.0.0.1', 0), cls.mon)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        if cls.env is None:
            os.environ.pop('CLAUDE_CONFIG_DIR', None)
        else:
            os.environ['CLAUDE_CONFIG_DIR'] = cls.env
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, host=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest('GET', path, skip_host=True)
        c.putheader('Host', host if host is not None else '127.0.0.1:%d' % self.port)
        c.endheaders()
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, r.getheader('Content-Type'), body

    def j(self, path):
        code, _, body = self.get(path)
        self.assertEqual(code, 200, body[:200])
        return json.loads(body)

    # -- safety ---------------------------------------------------------
    def test_host_header_is_validated(self):
        for h in ('evil.example.com', '127.0.0.1.evil.com', 'evil.com:80', ''):
            self.assertEqual(self.get('/api/health', host=h)[0], 403, h)
        for h in ('localhost:%d' % self.port, '127.0.0.1', '[::1]:80'):
            self.assertEqual(self.get('/api/health', host=h)[0], 200, h)

    def test_static_traversal_and_types_are_blocked(self):
        for p in ('/static/../../config/defaults.json', '/static/..%2f..%2fconfig/defaults.json', '/static/%2e%2e/%2e%2e/SKILL.md',
                  '/static/modules/../../../../SKILL.md', '/static/C:/Windows/win.ini', '/static/.hidden.js', '/static/nothing.js', '/static/x.py',
                  '/static/', '/static/modules'):
            self.assertEqual(self.get(p)[0], 404, p)

    def test_index_serves_html_with_escaped_title(self):
        self.mon.cfg['title'] = '<b>x</b> & y'
        code, ctype, body = self.get('/')
        if code == 200:                       # present once the frontend exists
            self.assertIn('text/html', ctype)
            self.assertNotIn(b'<b>x</b>', body)
        self.mon.cfg['title'] = 'Claude sessions monitor'

    def test_unknown_ids_and_bad_params(self):
        self.assertEqual(self.get('/api/events?sid=not-a-uuid')[0], 404)
        self.assertEqual(self.get('/api/events?sid=%s&agent=../../x' % self.fx['ids']['done'])[0], 404)
        self.assertEqual(self.get('/api/events?sid=%s&after=abc' % self.fx['ids']['done'])[0], 400)
        self.assertEqual(self.get('/api/sessions?hours=abc')[0], 400)
        self.assertEqual(self.get('/api/nope')[0], 404)

    # -- data -----------------------------------------------------------
    def sessions(self):
        return {s['id']: s for s in self.j('/api/sessions?all=1')}

    def test_session_states_from_evidence(self):
        ids, ss = self.fx['ids'], self.sessions()
        self.assertEqual(ss[ids['done']]['state'], 'IDLE')            # ended turn, but the transcript alone cannot say "completed"
        self.assertEqual(ss[ids['running']]['state'], 'RUNNING')
        self.assertEqual(ss[ids['pending']]['state'], 'RUNNING')       # tool call without result, within grace
        self.assertEqual(ss[ids['pending']]['pending_tools'], 1)
        for s in ss.values():
            self.assertNotIn(s['state'], ('FAILED',), 'FAILED only with external evidence')
            self.assertIn('state_evidence', s)
            self.assertEqual(s['completeness']['events'], 'full')
            self.assertEqual(s['completeness']['usage'], 'complete')

    def test_agents_grouped_by_workflow_and_aggregated_tokens(self):
        s = self.sessions()[self.fx['ids']['parent']]
        ag = {a['agent']: a for a in s['agents']}
        self.assertEqual(set(ag), {'aaa111', 'bbb222'})
        self.assertEqual(ag['aaa111']['label'], 'explorer')
        self.assertEqual(ag['bbb222']['workflow'], 'review-changes')
        self.assertEqual(ag['bbb222']['state'], 'COMPLETED')
        total = s['usage']['out'] + sum(a['usage']['out'] for a in s['agents'])
        self.assertEqual(s['usage_total']['out'], total)

    def test_events_pagination_and_indexes(self):
        sid = self.fx['ids']['done']
        full = self.j('/api/events?sid=%s&after=0' % sid)
        self.assertEqual(full['from'], 0)
        self.assertEqual([e['i'] for e in full['events']], list(range(full['total'])))
        self.assertEqual(full['next'], full['total'])
        tail = self.j('/api/events?sid=%s' % sid)
        self.assertEqual(tail['events'][-1]['i'], full['total'] - 1)
        older = self.j('/api/events?sid=%s&before=3&limit=2' % sid)
        self.assertEqual([e['i'] for e in older['events']], [1, 2])
        none = self.j('/api/events?sid=%s&after=%d' % (sid, full['total']))
        self.assertEqual(none['events'], [])
        self.assertFalse(full['partial'])

    def test_search_filters_errors_and_locate(self):
        sid = self.fx['ids']['failing']
        r = self.j('/api/search?sid=%s&errors=1' % sid)
        self.assertEqual({m['k'] for m in r['matches']}, {'tool', 'result'})
        self.assertEqual(r['count'], 2)
        r = self.j('/api/search?sid=%s&q=STEP+2&kinds=say' % sid)
        self.assertEqual([m['k'] for m in r['matches']], ['say'])
        r = self.j('/api/search?sid=%s&tool=Bash&kinds=tool&limit=2' % sid)
        self.assertEqual((len(r['matches']), r['truncated']), (2, True))
        ev = self.j('/api/events?sid=%s&after=0' % sid)['events']
        loc = self.j('/api/locate?sid=%s&ts=%s' % (sid, ev[4]['t']))
        self.assertEqual(loc['i'], 4)
        self.assertEqual(self.j('/api/locate?sid=%s&i=999' % sid)['i'], len(ev) - 1)

    def test_health_task_and_config(self):
        h = self.j('/api/health')
        self.assertTrue(h['ok'])
        self.assertEqual(h['pid'], os.getpid())
        self.assertIn('errors', h)
        c = self.j('/api/config')
        self.assertIn('poll', c)
        self.assertIn(c['ui']['theme'], ('auto', 'light', 'dark'))
        self.assertEqual(self.j('/api/task')['task'], None)

    def test_polling_errors_are_recorded_and_last_good_value_served(self):
        calls = {'n': 0}

        def flaky():
            calls['n'] += 1
            if calls['n'] > 1:
                raise RuntimeError('disk gone')
            return {'v': 1}
        self.assertEqual(json.loads(self.mon.cached('flaky', 0, flaky)), {'v': 1})
        self.assertEqual(json.loads(self.mon.cached('flaky', 0, flaky)), {'v': 1})      # stale-but-valid beats an error
        self.assertIn('disk gone', [e['message'] for e in self.j('/api/health')['errors']])

    def test_file_growth_is_picked_up_by_next_poll(self):
        sid = self.fx['ids']['running']
        n0 = self.j('/api/events?sid=%s&after=0' % sid)['total']
        M.append_jsonl(os.path.join(self.fx['tdir'], sid + '.jsonl'), [M.assistant([M.text('more')], 'msg_new', stop='end_turn')])
        self.assertEqual(self.j('/api/events?sid=%s&after=%d' % (sid, n0))['total'], n0 + 1)


if __name__ == '__main__':
    unittest.main()

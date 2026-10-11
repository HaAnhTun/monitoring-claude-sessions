import json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src'))
sys.path.insert(0, os.path.join(HERE, 'fixtures'))

from backend import config as C, state as S, tasks as T  # noqa: E402
from backend.panels import attempts_rows, external_map  # noqa: E402


def slurp(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def cls(**kw):
    a = dict(now=1000.0, mtime=1000.0, active_seconds=120, last_stop='end_turn', pending=0, oldest_pending_ts=0, agent_mtimes=[],
             grace_seconds=900, registry=None, external=None, has_records=True)
    a.update(kw)
    return S.classify_state(**a)


class StateTest(unittest.TestCase):
    def test_recent_write_is_running(self):
        self.assertEqual(cls(mtime=950)[0], 'RUNNING')

    def test_quiet_with_end_turn_is_idle_not_completed(self):
        self.assertEqual(cls(mtime=500)[0], 'IDLE')

    def test_completed_and_failed_need_external_evidence(self):
        self.assertEqual(cls(mtime=500, external={'state': 'COMPLETED', 'evidence': 'x'})[0], 'COMPLETED')
        self.assertEqual(cls(mtime=500, external={'state': 'FAILED', 'evidence': 'x'})[0], 'FAILED')
        for stop in ('end_turn', 'tool_use', '', None):
            self.assertNotIn(cls(mtime=0, last_stop=stop)[0], ('COMPLETED', 'FAILED'))

    def test_subagent_activity_keeps_parent_running(self):
        self.assertEqual(cls(mtime=500, agent_mtimes=[990])[0], 'RUNNING')
        self.assertEqual(cls(mtime=500, agent_mtimes=[800])[0], 'IDLE')

    def test_pending_tool_within_grace_is_running_then_unknown(self):
        self.assertEqual(cls(mtime=500, last_stop='tool_use', pending=1, oldest_pending_ts=500)[0], 'RUNNING')
        self.assertEqual(cls(now=5000, mtime=500, last_stop='tool_use', pending=1, oldest_pending_ts=500)[0], 'UNKNOWN')

    def test_registry_busy_idle(self):
        self.assertEqual(cls(mtime=0, registry={'status': 'busy'})[0], 'RUNNING')
        self.assertEqual(cls(mtime=0, last_stop='', registry={'status': 'idle'})[0], 'IDLE')

    def test_unreadable_is_unknown(self):
        self.assertEqual(cls(has_records=False)[0], 'UNKNOWN')

    def test_external_state_mapping(self):
        f = S.external_state
        self.assertIsNone(f(None))
        self.assertIsNone(f({'end': None}))
        self.assertEqual(f({'end': 1, 'exit': '0', 'status': 'PASS'})['state'], 'COMPLETED')
        self.assertEqual(f({'end': 1, 'exit': '1', 'status': 'PASS'})['state'], 'FAILED')
        self.assertEqual(f({'end': 1, 'exit': '0', 'status': 'BLOCKED'})['state'], 'FAILED')
        self.assertEqual(f({'end': 1, 'exit': '0', 'status': 'UNKNOWN'})['state'], 'UNKNOWN')

    def test_pid_alive_never_signals(self):
        self.assertTrue(S.pid_alive(os.getpid()))
        self.assertFalse(S.pid_alive(0))
        self.assertFalse(S.pid_alive('abc'))


class ConfigTest(unittest.TestCase):
    def test_defaults_are_valid(self):
        self.assertEqual(C.validate(C.load_defaults()), [])

    def test_merge_is_deterministic_and_dicts_merge_per_key(self):
        base = C.load_defaults()
        m = C.merge(base, {'panels': {'git': False}, 'window_hours': 24, 'session_rules': [{'match': 'x'}]})
        self.assertFalse(m['panels']['git'])
        self.assertTrue(m['panels']['machine'])
        self.assertEqual(m['window_hours'], 24)
        self.assertEqual(m['session_rules'], [{'match': 'x'}])
        self.assertEqual(base['window_hours'], 8)            # inputs are not mutated
        self.assertEqual(C.merge(base, {'window_hours': 24}), C.merge(base, {'window_hours': 24}))

    def test_validation_rejects_bad_values_and_unknown_keys(self):
        self.assertTrue(C.validate({'port': 'x'}))
        self.assertTrue(C.validate({'window_hours': -1}))
        self.assertTrue(C.validate({'nonsense': 1}))
        self.assertEqual(C.validate({'nonsense': 1}, strict=False), [])
        self.assertTrue(C.validate({'session_rules': [{'match': '('}]}))
        self.assertTrue(C.validate({'ui': {'theme': 'purple'}}))
        self.assertEqual(C.validate({'_comment': 'ok'}), [])

    def test_slug_rules(self):
        self.assertEqual(C.slugify('Nightly build: Steps A/B'), 'nightly-build-steps-a-b')
        for bad in ('../x', 'a/b', 'A', '', '.', '-x', 'x' * 60, 'nul'):
            with self.assertRaises(C.ConfigError):
                C.check_slug(bad)

    def test_schema_versions(self):
        with self.assertRaises(C.ConfigError):
            C.check_schema_version({}, 'f')
        with self.assertRaises(C.ConfigError):
            C.check_schema_version({'schema_version': 99}, 'f')
        C.check_schema_version({'schema_version': 1}, 'f')


class TaskTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.repo = os.path.join(self.d, 'repo')
        os.makedirs(self.repo)
        self.root = T.tasks_root(self.repo)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_init_creates_then_reuses_without_overwriting(self):
        d, created = T.init_task(self.root, self.repo, 'Nightly build', description='first')
        self.assertTrue(created)
        self.assertEqual(os.path.basename(d), 'nightly-build')
        T.configure(d, {'window_hours': 24}, reason='longer window')
        before = slurp(os.path.join(d, 'config.json'))
        d2, created2 = T.init_task(self.root, self.repo, 'Nightly build', description='other text')
        self.assertFalse(created2)
        self.assertEqual(d, d2)
        self.assertEqual(slurp(os.path.join(d, 'config.json')), before)
        self.assertEqual(len(T.list_tasks(self.root)), 1)

    def test_path_traversal_is_rejected(self):
        for bad in ('../evil', 'a/../../x', '..'):
            with self.assertRaises(C.ConfigError):
                T.task_dir(self.root, bad)
        with self.assertRaises(C.ConfigError):
            T.init_task(self.root, self.repo, 'x', slug='../escape')

    def test_configure_validates_audits_and_preserves_other_keys(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        T.configure(d, {'panels.git': False, 'window_hours': 12}, reason='r1')
        cfg = C.read_json(os.path.join(d, 'config.json'))
        self.assertEqual(cfg['panels'], {'git': False})
        self.assertEqual(cfg['title'], 'alpha')                    # untouched key survives
        self.assertEqual(cfg['schema_version'], 1)
        text = slurp(os.path.join(d, 'audit', 'changes.md'))
        self.assertIn('configure', text)
        self.assertIn('window_hours', text)
        self.assertIn('Reason: r1', text)
        self.assertEqual(T.last_change(d)['summary'].count('window_hours'), 1)

    def test_invalid_change_writes_nothing(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        before = slurp(os.path.join(d, 'config.json'))
        audit_before = slurp(os.path.join(d, 'audit', 'changes.md'))
        for bad in ({'port': 'abc'}, {'bogus': 1}, {'schema_version': 5}):
            with self.assertRaises(C.ConfigError):
                T.configure(d, bad)
        self.assertEqual(slurp(os.path.join(d, 'config.json')), before)
        self.assertEqual(slurp(os.path.join(d, 'audit', 'changes.md')), audit_before)

    def test_noop_configure_does_not_audit(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        T.configure(d, {'window_hours': 12})
        n = slurp(os.path.join(d, 'audit', 'changes.md')).count('## ')
        rep = T.configure(d, {'window_hours': 12})
        self.assertFalse(rep['changed'])
        self.assertEqual(slurp(os.path.join(d, 'audit', 'changes.md')).count('## '), n)

    def test_tasks_are_isolated(self):
        a, _ = T.init_task(self.root, self.repo, 'alpha')
        b, _ = T.init_task(self.root, self.repo, 'beta')
        snap = T.snapshot(self.root, exclude='alpha')
        T.configure(a, {'window_hours': 99, 'panels.machine': False}, reason='only alpha')
        T.record_decision(a, 'x', 'y')
        self.assertEqual(T.snapshot(self.root, exclude='alpha'), snap)
        self.assertNotEqual(C.read_json(os.path.join(a, 'config.json')), C.read_json(os.path.join(b, 'config.json')))
        cfg_b, meta_b = C.resolve_runtime(task_dir=b)
        self.assertEqual(cfg_b['window_hours'], 8)
        self.assertTrue(cfg_b['panels']['machine'])

    def test_inspect_reports_provenance(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        T.configure(d, {'window_hours': 3})
        info = T.inspect(self.root, 'alpha')
        self.assertEqual(info['provenance']['window_hours'], 'task')
        self.assertEqual(info['provenance']['active_seconds'], 'default')
        self.assertEqual(info['effective']['window_hours'], 3)
        self.assertIsNotNone(info['last_change'])

    def test_unsupported_schema_fails_safely(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        p = os.path.join(d, 'config.json')
        data = C.read_json(p)
        data['schema_version'] = 7
        C.write_json_atomic(p, data)
        with self.assertRaises(C.ConfigError):
            C.resolve_runtime(task_dir=d)
        with self.assertRaises(C.ConfigError):
            T.configure(d, {'window_hours': 1})
        self.assertEqual(C.read_json(p)['schema_version'], 7)         # not silently rewritten

    def test_audit_flags_problems(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        self.assertTrue(T.audit_tasks(self.root)[0]['ok'])
        open(os.path.join(d, 'copied.jsonl'), 'w').write('{}\n')
        r = T.audit_tasks(self.root)[0]
        self.assertFalse(r['ok'])
        self.assertIn('transcript copy', r['problems'][0])

    def test_repo_is_stored_relative_and_resolves(self):
        d, _ = T.init_task(self.root, self.repo, 'alpha')
        cfg, _ = C.resolve_runtime(task_dir=d)
        self.assertEqual(os.path.normcase(cfg['repo']), os.path.normcase(os.path.abspath(self.repo)))


class AttemptsTest(unittest.TestCase):
    def test_attempts_rows_and_external_states(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        log = os.path.join(d, 'chain.log')
        with open(log, 'w') as f:
            f.write('2026-10-11 10:00:00 PART A START attempt 1\n2026-10-11 10:05:00 PART A END exit=0 ledger=PASS\n'
                    '2026-10-11 10:06:00 PART B START attempt 1\n2026-10-11 10:07:00 PART B END exit=1 ledger=FAIL\n'
                    '2026-10-11 10:08:00 PART C START attempt 1\n')
        import time
        t = lambda s: time.mktime(time.strptime(s, '%Y-%m-%d %H:%M:%S'))
        cfg = dict(C.load_defaults(), repo=d, chain_log='chain.log', attempts={
            'label_prefix': 'P ', 'time_format': '%Y-%m-%d %H:%M:%S',
            'start': r'^(?P<time>\S+ \S+) PART (?P<part>[A-Z]) START attempt (?P<n>[0-9]+)',
            'end': r'^(?P<time>\S+ \S+) PART (?P<part>[A-Z]) END exit=(?P<exit>[0-9]+) ledger=(?P<status>[A-Z]+)'})
        sess = [{'label': 'P A', 'first_epoch': t('2026-10-11 10:00:05'), 'id': 'sa', 'usage_total': {}},
                {'label': 'P B', 'first_epoch': t('2026-10-11 10:06:02'), 'id': 'sb', 'usage_total': {}}]
        rows = attempts_rows(cfg, sess)
        self.assertEqual([(r['part'], r['state'], r['sid']) for r in rows], [('A', 'COMPLETED', 'sa'), ('B', 'FAILED', 'sb'), ('C', 'RUNNING', None)])
        ext = external_map(rows)
        self.assertEqual({k: v['state'] for k, v in ext.items()}, {'sa': 'COMPLETED', 'sb': 'FAILED'})


if __name__ == '__main__':
    unittest.main()

import contextlib, io, json, os, shutil, subprocess, sys, tempfile, unittest, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src'))
sys.path.insert(0, os.path.join(HERE, 'fixtures'))

import make as M  # noqa: E402
from backend import cli  # noqa: E402

VIEWER = os.path.join(HERE, '..', 'template', 'viewer.py')


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class CliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.env = os.environ.get('CLAUDE_CONFIG_DIR')
        cls.fx = M.build_home(os.path.join(cls.tmp, 'home'))
        os.environ['CLAUDE_CONFIG_DIR'] = cls.fx['home']
        cls.repo = os.path.join(cls.tmp, 'repo')
        os.makedirs(cls.repo)

    @classmethod
    def tearDownClass(cls):
        run('stop', '--repo', cls.repo, '--task', 'demo')
        if cls.env is None:
            os.environ.pop('CLAUDE_CONFIG_DIR', None)
        else:
            os.environ['CLAUDE_CONFIG_DIR'] = cls.env
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def cli(self, *a):
        return run(*a, '--repo', self.repo)

    def test_01_lifecycle_init_inspect_configure_audit(self):
        code, out, _ = self.cli('init-task', '--name', 'Demo', '--description', 'cli test')
        self.assertEqual(code, 0)
        self.assertIn('created', out)
        code, out, _ = self.cli('init-task', '--name', 'Demo')
        self.assertIn('reused', out)
        code, out, _ = self.cli('configure', '--task', 'demo', '--set', 'window_hours=24', '--set', 'panels.git=false',
                                '--set', 'transcripts_dir=' + json.dumps(self.fx['tdir']), '--set', 'include_unmatched=true', '--reason', 'test run')
        self.assertEqual(code, 0, out)
        self.assertTrue(json.loads(out)['changed'])
        code, out, err = self.cli('configure', '--task', 'demo', '--set', 'port="abc"')
        self.assertEqual(code, 1)
        self.assertIn('rejected', err)
        code, out, _ = self.cli('inspect', '--task', 'demo')
        info = json.loads(out)
        self.assertEqual(info['effective']['window_hours'], 24)
        self.assertIn('window_hours', info['overridden_keys'])
        self.assertIn('active_seconds', info['inherited_keys'])
        self.assertIn('test run', info['recent_audit'])
        self.assertEqual(self.cli('audit', '--task', 'demo')[0], 0)
        self.assertEqual(self.cli('configure', '--task', '../x', '--set', 'window_hours=1')[0], 1)

    def test_02_start_verify_status_idempotent_stop(self):
        code, out, err = self.cli('start', '--task', 'demo', '--port', '8830')
        self.assertEqual(code, 0, out + err)
        url = out.split('started: ')[1].split()[0]
        try:
            self.assertEqual(self.cli('start', '--task', 'demo', '--port', '8830')[1].split()[0], 'already')      # no second instance
            code, out, _ = self.cli('verify', '--task', 'demo')
            self.assertEqual(code, 0, out)
            code, out, _ = self.cli('status', '--task', 'demo')
            st = json.loads(out)
            self.assertTrue(st['running'])
            self.assertEqual(st['task']['id'], 'demo')
            self.assertEqual(sum(st['sessions'].values()), 5)
            self.assertEqual(st['sessions']['FAILED'], 0)
            self.assertFalse(st['outdated'])
            self.assertEqual(st['code_stamp'], cli.code_stamp())
            pid1 = st['pid']
            code, out, _ = self.cli('restart', '--task', 'demo', '--port', '8830')
            self.assertEqual(code, 0, out)
            code, out, _ = self.cli('status', '--task', 'demo')
            self.assertNotEqual(json.loads(out)['pid'], pid1)
            with urllib.request.urlopen(url + '/api/task') as r:
                self.assertEqual(json.load(r)['task']['id'], 'demo')
            code, out, _ = self.cli('doctor', '--task', 'demo')
            self.assertEqual(code, 0, out)
        finally:
            code, out, _ = self.cli('stop', '--task', 'demo')
        self.assertEqual(code, 0)
        self.assertIn('stopped', out)
        self.assertEqual(self.cli('status', '--task', 'demo')[0], 1)
        self.assertEqual(self.cli('verify', '--task', 'demo')[0], 1)

    def test_03_stale_state_file_and_pid_reuse_never_kill_other_processes(self):
        sf = os.path.join(self.repo, '.claude', 'monitor', 'tasks', 'demo', 'state.json')
        # pid of a live process that is NOT a viewer (this test runner): stop must refuse to kill it
        with open(sf, 'w') as f:
            json.dump({'pid': os.getpid(), 'url': 'http://127.0.0.1:1', 'port': 1}, f)
        code, out, _ = self.cli('stop', '--task', 'demo')
        self.assertEqual(code, 0)
        self.assertIn('not a viewer', out)
        self.assertFalse(os.path.exists(sf))
        # a dead pid: status reports not running and `doctor` flags the stale file, `start` replaces it
        with open(sf, 'w') as f:
            json.dump({'pid': 999999, 'url': 'http://127.0.0.1:1', 'port': 1}, f)
        self.assertEqual(self.cli('status', '--task', 'demo')[0], 1)
        code, out, _ = self.cli('doctor', '--task', 'demo')
        self.assertEqual(code, 1)
        self.assertIn('stale state file', out)
        os.remove(sf)

    def test_04_two_tasks_run_side_by_side_and_port_conflict_moves_on(self):
        self.cli('init-task', '--name', 'Second')
        self.cli('configure', '--task', 'second', '--set', 'transcripts_dir=' + json.dumps(self.fx['tdir']))
        a = self.cli('start', '--task', 'demo', '--port', '8840')
        b = self.cli('start', '--task', 'second', '--port', '8840')
        try:
            self.assertEqual((a[0], b[0]), (0, 0), a[1] + b[1] + a[2] + b[2])
            ua, ub = a[1].split('started: ')[1].split()[0], b[1].split('started: ')[1].split()[0]
            self.assertNotEqual(ua, ub)
        finally:
            self.cli('stop', '--task', 'demo')
            self.cli('stop', '--task', 'second')

    def test_05_legacy_flags_still_work(self):
        cfg = os.path.join(self.tmp, 'legacy.config.json')
        with open(cfg, 'w') as f:
            json.dump({'title': 'Legacy', 'repo': self.repo, 'transcripts_dir': self.fx['tdir'], 'panels': {'git': False}}, f)
        out = subprocess.run([sys.executable, VIEWER, '--config', cfg, '--check'], capture_output=True, text=True, timeout=60).stdout
        self.assertIn('title: Legacy', out)
        self.assertIn('source: legacy', out)
        out = subprocess.run([sys.executable, VIEWER, '--config', cfg, '--stop'], capture_output=True, text=True, timeout=60).stdout
        self.assertIn('nothing to stop', out)


if __name__ == '__main__':
    unittest.main()

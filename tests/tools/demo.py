"""Builds a self-contained demo project for screenshots and manual UI checks (all content is made up).

    python tests/tools/demo.py OUTDIR

Creates OUTDIR/home (a fake CLAUDE_CONFIG_DIR with transcripts), OUTDIR/repo (chain log + ledger) and
OUTDIR/demo.config.json. Run the viewer with CLAUDE_CONFIG_DIR=OUTDIR/home:
    CLAUDE_CONFIG_DIR=OUTDIR/home python template/viewer.py serve --config OUTDIR/demo.config.json
Sessions: A completed (chain log PASS), B failed (chain log FAIL, tool errors), C running with a tool still pending,
D idle, E very large (partial view), F a parent with a workflow and subagents,
G a tool call pending for over 30 minutes (UNKNOWN).
"""
import datetime, json, os, sys, time, uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures'))
import make as M  # noqa: E402

NOW = datetime.datetime.now(datetime.timezone.utc)


def at(sec_ago):
    return NOW - datetime.timedelta(seconds=sec_ago)


def usage(i, o, cr, cc):
    return {'input_tokens': i, 'output_tokens': o, 'cache_read_input_tokens': cr, 'cache_creation_input_tokens': cc}


def session(step, prompt, start_ago, steps, final=None, pending=None, mid='m'):
    """steps: list of (say, tool_name, tool_input, result_text, is_error). Timestamps advance 6 s per step."""
    recs = [M.user('Run STEP=%s: %s' % (step, prompt), M.iso(0, at(start_ago)))]
    t = 2
    for i, (say, name, inp, res, err) in enumerate(steps):
        tid = 'toolu_%s%02d' % (step, i)
        recs.append(M.assistant([M.text(say), M.tool(tid, name, **inp)], '%s_%s%02d' % (mid, step, i), M.iso(t, at(start_ago)),
                                usage=usage(40 + i, 220 + 10 * i, 12000 * (i + 1), 900), stop='tool_use'))
        if res is not None:
            recs.append(M.result(tid, res, err=err, ts=M.iso(t + 3, at(start_ago))))
        t += 6
    if pending:
        recs.append(M.assistant([M.text(pending[0]), M.tool('toolu_%s_pending' % step, 'Bash', command=pending[1])], '%s_%s_p' % (mid, step), M.iso(t, at(start_ago)),
                                usage=usage(30, 150, 90000, 400), stop='tool_use'))
    if final:
        recs.append(M.assistant([M.text(final)], '%s_%s_f' % (mid, step), M.iso(t, at(start_ago)), usage=usage(20, 380, 140000, 300), stop='end_turn'))
    return recs


def build(out):
    out = os.path.abspath(out)
    home, repo = os.path.join(out, 'home'), os.path.join(out, 'repo')
    tdir = os.path.join(home, 'projects', 'demo')
    os.makedirs(os.path.join(repo, 'logs'), exist_ok=True)
    os.makedirs(os.path.join(repo, 'docs'), exist_ok=True)
    ids = {k: str(uuid.uuid4()) for k in 'ABCDEFG'}

    A = session('A', 'compile the backend and run the unit tests', 3000, [
        ('Starting with a clean compile.', 'Bash', {'command': 'mvn -q -DskipTests clean package'}, 'BUILD SUCCESS (12.4 s)', False),
        ('Compiled. Now the unit tests.', 'Bash', {'command': 'mvn -q test'}, 'Tests run: 214, Failures: 0, Errors: 0, Skipped: 2', False),
        ('Checking that no generated file is left untracked.', 'Bash', {'command': 'git status --short'}, '', False),
    ], 'Backend compiles and all 214 unit tests pass (2 skipped, both marked @Disabled upstream). No untracked files.')

    B = session('B', 'run the integration tests against the staging database', 2600, [
        ('Running the integration suite.', 'Bash', {'command': 'mvn -q verify -Pintegration'},
         'Tests run: 58, Failures: 3, Errors: 1\n[ERROR] OrderRepositoryIT.findByCustomer:41 expected:<3> but was:<0>\n[ERROR] CheckoutFlowIT.payment:88 NullPointerException', True),
        ('Three failures in the order repository. Looking at the fixture.', 'Read', {'file_path': 'src/test/resources/orders.sql'},
         '-- orders.sql\nINSERT INTO orders (id, customer_id, total) VALUES (1, 7, 19.90);', False),
        ('The fixture inserts customer 7 but the test queries customer 9. Re-running only that test after fixing the id.', 'Bash',
         {'command': 'mvn -q verify -Pintegration -Dtest=OrderRepositoryIT'}, 'Tests run: 6, Failures: 0, Errors: 0', False),
        ('Now the checkout flow, which still throws.', 'Bash', {'command': 'mvn -q verify -Pintegration -Dtest=CheckoutFlowIT'},
         'java.lang.NullPointerException: Cannot invoke "PaymentGateway.charge" because "gateway" is null\n\tat CheckoutFlowIT.payment(CheckoutFlowIT.java:88)', True),
    ], 'Stopping here: CheckoutFlowIT needs a PaymentGateway stub that does not exist yet. Order repository tests are fixed; checkout is blocked.')

    C = session('C', 'deploy the build to staging and run smoke checks', 220, [
        ('Building the container image.', 'Bash', {'command': 'docker build -t shop-api:staging .'}, 'Successfully tagged shop-api:staging', False),
        ('Pushing it to the registry.', 'Bash', {'command': 'docker push registry.example.test/shop-api:staging'}, 'staging: digest: sha256:9f3a... size: 2417', False),
    ], pending=('Rolling out and waiting for the deployment to become ready.', 'kubectl rollout status deploy/shop-api --timeout=600s'))

    D = session('D', 'draft the release notes from the merged pull requests', 1700, [
        ('Listing merged pull requests since the last tag.', 'Bash', {'command': 'git log --merges --since=v1.4.0 --format=%s'},
         'Merge PR #212: fix cart rounding\nMerge PR #214: add order export\nMerge PR #219: upgrade framework', False),
    ], 'Draft release notes written to docs/release-notes-draft.md. Waiting for your review before I publish anything.')

    big_steps = []
    for i in range(420):
        big_steps.append(('Refactoring module %03d: extracting an interface and updating call sites.' % i, 'Edit',
                          {'file_path': 'src/main/java/com/shop/module%03d/Service.java' % i}, 'The file has been updated. ' + 'x' * 400, False))
    E = session('E', 'refactor all service classes to use constructor injection', 4000, big_steps, 'Refactor of 420 modules finished; the build is green.')

    F = session('F', 'review the changes of the last release across four areas', 300, [
        ('Splitting the review into parallel agents (security, performance, tests, docs).', 'Bash', {'command': 'git diff --stat v1.4.0..HEAD'}, '48 files changed, 1311 insertions(+), 402 deletions(-)', False),
    ], pending=('Waiting for the four review agents to report back.', 'sleep 300'))

    G = session('G', 'sync the translation files with the translation service', 2600, [
        ('Exporting the source strings.', 'Bash', {'command': 'npm run i18n:export'}, 'Exported 1204 strings', False),
    ], pending=('Uploading and waiting for the service to confirm.', 'npm run i18n:upload -- --wait'))

    for k, recs in (('A', A), ('B', B), ('C', C), ('D', D), ('E', E), ('F', F), ('G', G)):
        M.write_jsonl(os.path.join(tdir, ids[k] + '.jsonl'), recs)
    sub = os.path.join(tdir, ids['F'], 'subagents', 'workflows', 'wf-review')
    os.makedirs(os.path.join(tdir, ids['F'], 'workflows'), exist_ok=True)
    with open(os.path.join(tdir, ids['F'], 'workflows', 'wf-review.json'), 'w') as f:
        json.dump({'workflowName': 'parallel-review', 'status': 'running'}, f)
    agents = [('sec001', 'security review', 'sonnet', 280, True), ('perf02', 'performance review', 'sonnet', 260, False),
              ('test03', 'test coverage review', 'haiku', 200, False), ('docs04', 'documentation review', 'haiku', 190, False)]
    for aid, label, model, ago, fresh in agents:
        recs = session(aid[:3].upper(), 'review ' + label, ago, [
            ('Reading the diff for this area.', 'Bash', {'command': 'git diff v1.4.0..HEAD -- src/main'}, 'diff --git a/... (2310 lines)', False),
            ('Looking for problems.', 'Grep', {'pattern': 'TODO|FIXME', 'path': 'src'}, 'src/main/Pricing.java:57: // TODO rounding', False)],
            None if fresh else 'Review finished: no blocking issues, 3 minor suggestions listed in the report.',
            pending=('Cross-checking findings against the tests.', 'mvn -q test -Dtest=PricingTest') if fresh else None, mid='ag')
        M.write_jsonl(os.path.join(sub, 'agent-%s.jsonl' % aid), recs)
        with open(os.path.join(sub, 'agent-%s.meta.json' % aid), 'w') as f:
            json.dump({'label': label, 'model': model}, f)

    # ages: A,B,D,E idle for a while; C and F written recently; finished agents idle, the security agent is still working
    age = {'A': 2400, 'B': 1900, 'C': 25, 'D': 1500, 'E': 300, 'F': 20, 'G': 2000}
    for k, secs in age.items():
        M.age(os.path.join(tdir, ids[k] + '.jsonl'), secs)
    for aid, _, _, _, fresh in agents:
        M.age(os.path.join(sub, 'agent-%s.jsonl' % aid), 8 if fresh else 400)

    fmt = lambda t: t.astimezone().strftime('%Y-%m-%d %H:%M:%S')
    log = [
        '%s STEP A START attempt 1 model sonnet effort medium' % fmt(at(3000 - 1)),
        '%s STEP A END exit=0 status=PASS' % fmt(at(2400)),
        '%s STEP B START attempt 1 model sonnet effort medium' % fmt(at(2600 - 1)),
        '%s STEP B END exit=1 status=FAIL' % fmt(at(1900)),
        '%s STEP C START attempt 1 model haiku effort low' % fmt(at(220 - 1)),
        '%s STEP F START attempt 1 model opus effort high' % fmt(at(300 - 1)),
    ]
    with open(os.path.join(repo, 'logs', 'chain.log'), 'w') as f:
        f.write('\n'.join(log) + '\n')
    with open(os.path.join(repo, 'docs', 'status.md'), 'w') as f:
        f.write('| Step | Status | Notes |\n|---|---|---|\n| A | PASS | compile + unit tests |\n| B | FAIL | CheckoutFlowIT blocked |\n| C | RUNNING | deploy to staging |\n| D | DONE | release notes draft |\n| F | RUNNING | parallel review |\n')
    cfg = {
        'title': 'Nightly build monitor', 'repo': repo, 'transcripts_dir': tdir, 'window_hours': 8,
        'session_rules': [{'match': 'STEP=([A-Z]):', 'label': 'build step {1}'}],
        'panels': {'machine': True, 'git': False, 'logs': False, 'ledger': True, 'chain_log': True, 'attempts': True},
        'chain_log': 'logs/chain.log', 'ledger': 'docs/status.md', 'docker': False,
        'watched_processes': ['chrome.exe', 'node.exe', 'python.exe', 'java.exe'],
        'attempts': {'label_prefix': 'build step ', 'time_format': '%Y-%m-%d %H:%M:%S',
                     'start': r'^(?P<time>\S+ \S+) STEP (?P<part>[A-Z]) START attempt (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)',
                     'end': r'^(?P<time>\S+ \S+) STEP (?P<part>[A-Z]) END exit=(?P<exit>[0-9]+) status=(?P<status>[A-Z]+)'},
        'limits': {'event_window_mb': 0.2},
        'port': 8860,
    }
    with open(os.path.join(out, 'demo.config.json'), 'w') as f:
        json.dump(cfg, f, indent=2)
    return {'out': out, 'home': home, 'ids': ids}


if __name__ == '__main__':
    print(json.dumps(build(sys.argv[1] if len(sys.argv) > 1 else 'demo-out'), indent=2))

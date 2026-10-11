"""Synthetic transcript builders (no real data). Used by the unit tests and for manual UI checks:
    python tests/fixtures/make.py OUTDIR      -> writes a fake CLAUDE_CONFIG_DIR with a few sessions
then run the viewer with CLAUDE_CONFIG_DIR=OUTDIR and a config whose transcripts_dir is OUTDIR/projects/demo."""
import datetime, json, os, sys, uuid


def iso(offset_s=0.0, base=None):
    t = (base or datetime.datetime.now(datetime.timezone.utc)) + datetime.timedelta(seconds=offset_s)
    return t.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def user(text, ts=None):
    return {'type': 'user', 'timestamp': ts or iso(), 'uuid': str(uuid.uuid4()), 'message': {'role': 'user', 'content': text}}


def assistant(blocks, mid, ts=None, usage=None, stop=None, model='claude-sonnet-5-5'):
    return {'type': 'assistant', 'timestamp': ts or iso(), 'uuid': str(uuid.uuid4()),
            'message': {'id': mid, 'role': 'assistant', 'model': model, 'content': blocks, 'stop_reason': stop,
                        'usage': usage or {'input_tokens': 10, 'output_tokens': 5, 'cache_read_input_tokens': 100, 'cache_creation_input_tokens': 20}}}


def text(s):
    return {'type': 'text', 'text': s}


def tool(tid, name='Bash', **inp):
    return {'type': 'tool_use', 'id': tid, 'name': name, 'input': inp or {'command': 'echo hi'}}


def result(tid, s='ok', err=False, ts=None):
    return {'type': 'user', 'timestamp': ts or iso(), 'uuid': str(uuid.uuid4()),
            'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tid, 'content': s, 'is_error': err}]}}


def write_jsonl(path, records, newline_at_end=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(json.dumps(r) for r in records) + ('\n' if newline_at_end else ''))


def append_jsonl(path, records):
    with open(path, 'a', encoding='utf-8', newline='\n') as f:
        for r in records:
            f.write(json.dumps(r) + '\n')


def age(path, seconds):
    """Pretend the file was last written `seconds` ago."""
    import time
    t = time.time() - seconds
    os.utime(path, (t, t))


def conversation(n_tools=3, fail_at=None, start=None, finish=True):
    """A believable session: prompt, then n tool calls (one optionally failing), then a final answer."""
    base = start or datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=10)
    recs = [user('Please run the build job', iso(0, base))]
    for i in range(n_tools):
        tid = 'toolu_%03d' % i
        recs.append(assistant([text('step %d' % i), tool(tid, command='make step%d' % i)], 'msg_%03d' % i, iso(2 * i + 1, base), stop='tool_use'))
        recs.append(result(tid, 'boom' if fail_at == i else 'done %d' % i, err=fail_at == i, ts=iso(2 * i + 2, base)))
    if finish:
        recs.append(assistant([text('All finished.')], 'msg_final', iso(2 * n_tools + 3, base), stop='end_turn'))
    return recs


def build_home(out, project='demo'):
    """Fake CLAUDE_CONFIG_DIR with sessions of every interesting kind. Returns {'home', 'tdir', 'ids': {...}}."""
    home = os.path.abspath(out)
    tdir = os.path.join(home, 'projects', project)
    ids = {k: str(uuid.uuid4()) for k in ('done', 'failing', 'running', 'pending', 'parent')}
    write_jsonl(os.path.join(tdir, ids['done'] + '.jsonl'), conversation(3))
    write_jsonl(os.path.join(tdir, ids['failing'] + '.jsonl'), conversation(4, fail_at=2))
    now = datetime.datetime.now(datetime.timezone.utc)
    write_jsonl(os.path.join(tdir, ids['running'] + '.jsonl'), conversation(2, start=now - datetime.timedelta(seconds=20), finish=False))
    pend = conversation(1, finish=False, start=now - datetime.timedelta(seconds=5))
    pend.append(assistant([tool('toolu_pending', command='sleep 600')], 'msg_pend', iso(0), stop='tool_use'))
    write_jsonl(os.path.join(tdir, ids['pending'] + '.jsonl'), pend)
    sid = ids['parent']
    write_jsonl(os.path.join(tdir, sid + '.jsonl'), conversation(2))
    sub = os.path.join(tdir, sid, 'subagents')
    write_jsonl(os.path.join(sub, 'agent-aaa111.jsonl'), conversation(1))
    with open(os.path.join(sub, 'agent-aaa111.meta.json'), 'w') as f:
        json.dump({'label': 'explorer', 'model': 'haiku'}, f)
    wf = os.path.join(sub, 'workflows', 'wf1')
    write_jsonl(os.path.join(wf, 'agent-bbb222.jsonl'), conversation(1, fail_at=0))
    os.makedirs(os.path.join(tdir, sid, 'workflows'), exist_ok=True)
    with open(os.path.join(tdir, sid, 'workflows', 'wf1.json'), 'w') as f:
        json.dump({'workflowName': 'review-changes', 'status': 'completed'}, f)
    for k, secs in (('done', 600), ('failing', 600), ('pending', 300), ('parent', 600)):
        age(os.path.join(tdir, ids[k] + '.jsonl'), secs)
    for root, _, files in os.walk(os.path.join(tdir, sid)):
        for n in files:
            age(os.path.join(root, n), 600)
    return {'home': home, 'tdir': tdir, 'ids': ids}


if __name__ == '__main__':
    r = build_home(sys.argv[1] if len(sys.argv) > 1 else 'demo-home')
    print(json.dumps(r, indent=2))

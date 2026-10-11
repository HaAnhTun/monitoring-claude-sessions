import json, os, shutil, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src'))
sys.path.insert(0, os.path.join(HERE, 'fixtures'))

import make as M  # noqa: E402
from backend.reader import TranscriptReader, events_of  # noqa: E402


def full_scan_usage(path):
    """Independent reference: parse the whole file at once, dedupe by message id (max of each field)."""
    msgs = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('type') == 'assistant':
                m, u = r['message'], r['message'].get('usage') or {}
                cur = msgs.setdefault(m.get('id'), [0, 0, 0, 0])
                for i, k in enumerate(('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')):
                    cur[i] = max(cur[i], u.get(k) or 0)
    return [sum(v[i] for v in msgs.values()) for i in range(4)]


def tot(u):
    return [u['in'], u['out'], u['cr'], u['cc']]


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, 's.jsonl')

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def reader(self, **kw):
        return TranscriptReader(self.p, **kw).want_events() if kw.pop('keep', True) else TranscriptReader(self.p, **kw)

    def test_incremental_equals_full_scan_while_file_grows(self):
        recs = M.conversation(6)
        M.write_jsonl(self.p, recs[:4])
        rd = TranscriptReader(self.p)
        rd.refresh()
        rd.want_events()
        for chunk in (recs[4:7], recs[7:10], recs[10:]):
            M.append_jsonl(self.p, chunk)
            rd.refresh()
        self.assertEqual(tot(rd.usage()), full_scan_usage(self.p))
        fresh = TranscriptReader(self.p)
        fresh.want_events()
        self.assertEqual([e['k'] for e in rd.slice(0)], [e['k'] for e in fresh.slice(0)])
        self.assertEqual([e['i'] for e in rd.slice(0)], list(range(rd.total)))

    def test_duplicate_records_of_one_message_are_counted_once(self):
        u = {'input_tokens': 7, 'output_tokens': 3, 'cache_read_input_tokens': 50, 'cache_creation_input_tokens': 9}
        recs = [M.user('go'), M.assistant([M.text('a')], 'm1', usage=u), M.assistant([M.tool('t1')], 'm1', usage=u),
                M.assistant([M.text('b')], 'm2', usage=dict(u, output_tokens=1), stop='end_turn'),
                M.assistant([M.text('b')], 'm2', usage=dict(u, output_tokens=4), stop='end_turn')]
        M.write_jsonl(self.p, recs)
        r = TranscriptReader(self.p).refresh().usage()
        self.assertEqual((r['in'], r['out'], r['cr'], r['cc'], r['turns']), (14, 3 + 4, 100, 18, 2))
        self.assertTrue(r['complete'])

    def test_missing_usage_fields_and_unknown_types_do_not_break(self):
        recs = [M.user('x'), {'type': 'assistant', 'message': {'id': 'm1', 'content': [M.text('hi')]}}, {'type': 'brand-new-type', 'timestamp': M.iso()},
                {'type': 'assistant', 'message': 'not a dict'}, {'type': 'user', 'message': {'content': None}}, ['not', 'a', 'dict']]
        M.write_jsonl(self.p, recs)
        rd = TranscriptReader(self.p).refresh()
        self.assertEqual(rd.usage()['turns'], 1)
        self.assertGreaterEqual(rd.unknown_records, 1)      # the new record type is counted, not fatal
        self.assertEqual(rd.invalid_lines, 1)               # the JSON array line is not a record

    def test_invalid_json_lines_are_counted_and_skipped(self):
        M.write_jsonl(self.p, M.conversation(1))
        with open(self.p, 'a', encoding='utf-8') as f:
            f.write('{this is not json}\n')
        M.append_jsonl(self.p, M.conversation(1))
        rd = TranscriptReader(self.p).refresh()
        self.assertEqual(rd.invalid_lines, 1)
        self.assertEqual(rd.usage()['turns'], 2)       # the same two message ids appear twice: counted once

    def test_partial_last_line_is_not_consumed_until_complete(self):
        recs = M.conversation(2)
        M.write_jsonl(self.p, recs[:3])
        line = json.dumps(recs[3])
        with open(self.p, 'a', encoding='utf-8', newline='\n') as f:
            f.write(line[:30])                 # writer stopped mid-record
        rd = TranscriptReader(self.p).want_events()
        n = rd.total
        self.assertEqual(rd.invalid_lines, 0)
        self.assertTrue(rd.usage()['complete'], 'a writer mid-line must not look like an incomplete scan')
        with open(self.p, 'a', encoding='utf-8', newline='\n') as f:
            f.write(line[30:] + '\n')
        rd.refresh()
        self.assertGreater(rd.total, n)
        self.assertEqual(rd.invalid_lines, 0)

    def test_unterminated_but_valid_last_record_is_accepted(self):
        M.write_jsonl(self.p, M.conversation(1), newline_at_end=False)
        rd = TranscriptReader(self.p).want_events()
        self.assertEqual(rd.slice(0)[-1]['k'], 'say')

    def test_truncation_and_replacement_reset_the_reader(self):
        M.write_jsonl(self.p, M.conversation(4))
        rd = TranscriptReader(self.p).want_events()
        before = rd.total
        M.write_jsonl(self.p, M.conversation(1))          # replaced by a smaller, different file
        rd.refresh()
        self.assertLess(rd.total, before)
        self.assertEqual(tot(rd.usage()), full_scan_usage(self.p))
        # replaced by a LARGER different file: size alone would not reveal it
        M.write_jsonl(self.p, M.conversation(9))
        rd.refresh()
        fresh = TranscriptReader(self.p).want_events()
        self.assertEqual(rd.total, fresh.total)
        self.assertEqual(tot(rd.usage()), full_scan_usage(self.p))

    def test_big_file_events_are_partial_and_usage_converges(self):
        recs = M.conversation(40)
        M.write_jsonl(self.p, recs)
        size = os.path.getsize(self.p)
        import backend.reader as R
        old, R.CHUNK = R.CHUNK, 2000       # small chunks so a zero budget stops after the first one
        self.addCleanup(setattr, R, 'CHUNK', old)
        rd = TranscriptReader(self.p, window_bytes=size // 4, budget_s=0.0).want_events()
        c = rd.completeness()
        self.assertEqual(c['events'], 'partial')
        self.assertGreater(c['events_skipped_bytes'], 0)
        self.assertEqual(rd.usage()['complete'], False)         # budget 0: first poll cannot finish the scan
        for _ in range(50):
            rd.refresh()
        self.assertTrue(rd.usage()['complete'])
        self.assertEqual(tot(rd.usage()), full_scan_usage(self.p))
        self.assertEqual(rd.usage()['scanned_pct'], 100)

    def test_usage_unavailable_over_size_limit(self):
        M.write_jsonl(self.p, M.conversation(5))
        rd = TranscriptReader(self.p, usage_max_bytes=100).want_events()
        self.assertEqual(rd.completeness()['usage'], 'unavailable')
        self.assertTrue(rd.usage().get('skipped'))
        self.assertGreater(rd.total, 0)             # events still work

    def test_record_longer_than_a_chunk_still_parses(self):
        big = 'x' * (5 * 1024 * 1024)
        M.write_jsonl(self.p, [M.user('small'), M.assistant([M.text(big)], 'm1', stop='end_turn'), M.user('after')])
        rd = TranscriptReader(self.p).want_events()
        self.assertEqual(rd.invalid_lines, 0)
        self.assertEqual([e['k'] for e in rd.slice(0)], ['prompt', 'say', 'prompt'])
        self.assertIn('truncated', rd.slice(0)[1]['text'])

    def test_event_cap_drops_oldest_but_indexes_stay_absolute(self):
        M.write_jsonl(self.p, M.conversation(30))
        rd = TranscriptReader(self.p, max_events=20).want_events()
        evs = rd.slice(rd.base)
        self.assertEqual(len(evs), 20)
        self.assertEqual(evs[0]['i'], rd.base)
        self.assertEqual(evs[-1]['i'], rd.total - 1)
        self.assertEqual(rd.completeness()['events'], 'partial')

    def test_pending_tools_track_calls_without_results(self):
        M.write_jsonl(self.p, [M.user('go'), M.assistant([M.tool('t1')], 'm1', stop='tool_use'), M.assistant([M.tool('t2')], 'm1', stop='tool_use'),
                               M.result('t1')])
        rd = TranscriptReader(self.p).refresh()
        self.assertEqual(sorted(rd.pending), ['t2'])

    def test_events_of_shapes(self):
        ev = events_of(M.assistant([M.text('hi'), M.tool('t1', file_path='/a/b')], 'm1'))
        self.assertEqual([e['k'] for e in ev], ['say', 'tool'])
        self.assertEqual(ev[1]['summary'], '/a/b')
        er = events_of(M.result('t1', 'bad', err=True))[0]
        self.assertTrue(er['err'])
        self.assertEqual(er['id'], 't1')

    def test_missing_file_is_unreadable_not_an_error(self):
        rd = TranscriptReader(os.path.join(self.d, 'nope.jsonl')).refresh()
        self.assertTrue(rd.unreadable)


if __name__ == '__main__':
    unittest.main()

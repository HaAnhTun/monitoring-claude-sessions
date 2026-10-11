"""L1 vectors of the golden capture (design 06 sections 5.1 and 5.2.4): pure legacy functions called with crafted inputs.

Each vector file is a list of {"case", "input", "output"}. The input is round-tripped through the golden JSON serialisation
(sorted keys) BEFORE the legacy function runs, so the stored output is always the legacy result for exactly the stored input
(a case whose result would depend on dict key order cannot sneak in). Inputs that must keep a float spelling (`1.0`), an
integer-like key order or duplicate keys are given as JSON text (`text`, `value_json`); everything else is plain JSON.
When a legacy function raises, the output is {"raises": "<ExceptionClass>"} (plus "message" for ConfigError); for
`strptime.json` every failure is `null` (design 06 5.2.4). Source files use only ASCII: non-ASCII data is built from
escapes so that no tool in the chain can alter it.
"""
import base64
import json
import os
import time
import warnings

import determinism as D
import panel_scenarios as P

NOW = 1790000000
LS = '\N{LINE SEPARATOR}'
PS = '\N{PARAGRAPH SEPARATOR}'
NEL = '\x85'
EMOJI = '\U0001F642'
E_ACUTE = '\N{LATIN SMALL LETTER E WITH ACUTE}'
COMBINING_ACUTE = '\N{COMBINING ACUTE ACCENT}'
FAMILY = '\U0001F468\N{ZERO WIDTH JOINER}\U0001F469\N{ZERO WIDTH JOINER}\U0001F467'


def _rt(x):
    return json.loads(json.dumps(x, sort_keys=True, ensure_ascii=False))


class Cases(object):
    def __init__(self):
        self.rows, self._names = [], set()

    def add(self, name, inp, fn):
        if name in self._names:
            raise RuntimeError('duplicate vector case name: ' + name)
        self._names.add(name)
        inp = _rt(inp)
        self.rows.append({'case': name, 'input': inp, 'output': _rt(fn(inp))})


def _outcome(L, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001  (every legacy failure is data here)
        out = {'raises': type(e).__name__}
        if isinstance(e, L.C.ConfigError):
            out['message'] = str(e)
        return out


# ---- splitlines ---------------------------------------------------------------------------------------------------------------

def splitlines(L, ctx):
    c = Cases()
    seps = [('lf', '\n'), ('cr', '\r'), ('crlf', '\r\n'), ('vt', '\x0b'), ('ff', '\x0c'), ('fs', '\x1c'), ('gs', '\x1d'),
            ('rs', '\x1e'), ('nel', NEL), ('ls', LS), ('ps', PS)]
    for name, sep in seps:
        c.add('boundary-' + name, {'text': 'a' + sep + 'b' + sep}, lambda i: i['text'].splitlines())
    for name, ch in [('us', '\x1f'), ('nul', '\x00'), ('tab', '\t'), ('nbsp', '\N{NO-BREAK SPACE}'), ('zwsp', '\N{ZERO WIDTH SPACE}'),
                     ('bom', '\N{ZERO WIDTH NO-BREAK SPACE}'), ('esc', '\x1b')]:
        c.add('not-a-boundary-' + name, {'text': 'a' + ch + 'b'}, lambda i: i['text'].splitlines())
    texts = [('empty', ''), ('only-lf', '\n'), ('only-crlf', '\r\n'), ('two-lf', '\n\n'), ('lf-cr', '\n\r'), ('cr-cr-lf', '\r\r\n'),
             ('crlf-crlf', '\r\n\r\n'), ('no-terminator', 'abc'), ('blank-middle', 'a\n\nb'), ('trailing-lf', 'a\nb\n'),
             ('trailing-two-lf', 'a\nb\n\n'), ('spaces', ' \n '), ('mixed', 'a\r\nb\rc\nd' + NEL + 'e' + LS + 'f' + PS + 'g\x0bh\x0ci\x1cj'),
             ('emoji', 'a' + EMOJI + '\n' + EMOJI), ('lone-cr-end', 'a\r'), ('nel-end', 'a' + NEL), ('bom-first', '\N{ZERO WIDTH NO-BREAK SPACE}a\nb')]
    for name, t in texts:
        c.add('text-' + name, {'text': t}, lambda i: i['text'].splitlines())
    return c.rows


# ---- tail ---------------------------------------------------------------------------------------------------------------------

def _seg(data, repeat=1):
    return {'hex': data.hex(), 'repeat': repeat}


def _content(segments):
    return b''.join(bytes.fromhex(s['hex']) * s['repeat'] for s in segments)


def tail(L, ctx):
    """panels.tail_lines(path, n) on files described by hex segments ({hex, repeat}); a missing file is {"missing": true}."""
    c = Cases()
    path = os.path.join(ctx['tmp'], 'tail-vector.bin')

    def run(i):
        if i.get('missing'):
            return L.panels.tail_lines(os.path.join(ctx['tmp'], 'no-such-file.log'), i['n'])
        with open(path, 'wb') as f:
            f.write(_content(i['segments']))
        try:
            return L.panels.tail_lines(path, i['n'])
        finally:
            os.remove(path)

    def case(name, n, *segments):
        c.add(name, {'n': n, 'segments': list(segments)}, run)

    c.add('missing-file', {'n': 5, 'missing': True}, run)
    case('empty-file', 5)
    case('single-line-no-terminator', 5, _seg(b'only line'))
    case('fewer-than-n', 5, _seg(b'a\nb\nc\n'))
    case('exactly-n', 3, _seg(b'a\nb\nc\n'))
    case('more-than-n', 2, _seg(b'a\nb\nc\nd\n'))
    case('n-is-one', 1, _seg(b'a\nb\nc\n'))
    case('trailing-blank-lines', 3, _seg(b'a\nb\n\n\n'))
    case('crlf', 2, _seg(b'a\r\nb\r\nc\r\n'))
    case('cr-only', 2, _seg(b'a\rb\rc\r'))
    case('nel', 3, _seg(b'a\xc2\x85b\xc2\x85c\n'))
    case('line-separator', 3, _seg(b'a\xe2\x80\xa8b\xe2\x80\xa8c\n'))
    case('paragraph-separator', 3, _seg(b'a\xe2\x80\xa9b\xe2\x80\xa9c\n'))
    case('vt-ff-fs', 4, _seg(b'a\x0bb\x0cc\x1cd\n'))
    case('invalid-byte-mid-line', 3, _seg(b'ok\nbad \xff byte\nok2\n'))
    case('truncated-multibyte-at-end', 2, _seg(b'a\nb \xc3'))
    case('bom-first-line', 2, _seg(b'\xef\xbb\xbfhead\nbody\n'))
    case('utf8-text', 2, _seg(('caf' + E_ACUTE + ' ' + EMOJI + '\nsecond\n').encode('utf-8')))
    case('file-of-exactly-65536-bytes', 2, _seg(b'line\n', 13107), _seg(b'x'))
    case('file-of-65537-bytes', 2, _seg(b'line\n', 13107), _seg(b'xy'))
    case('many-short-lines-last-n', 200, _seg(b'a' * 50 + b'\n', 2000))
    case('many-short-lines-n-three', 3, _seg(b'a' * 50 + b'\n', 2000))
    e2 = E_ACUTE.encode('utf-8')
    case('cut-inside-two-byte-character', 1, _seg(e2, 32768), _seg(b'\n'))  # 65537 bytes: the seek lands on a continuation byte
    return c.rows


# ---- strptime -----------------------------------------------------------------------------------------------------------------

def strptime(L, ctx):
    """time.mktime(time.strptime(text, format)) under the pinned zone; any failure (ValueError, OverflowError) is null."""
    c = Cases()

    def run(i):
        try:
            return time.mktime(time.strptime(i['text'], i['format']))
        except Exception:  # noqa: BLE001
            return None

    F = '%Y-%m-%d %H:%M:%S'
    rows = [
        ('standard', F, '2026-09-21 14:13:20'), ('midnight', F, '2026-01-01 00:00:00'), ('leap-day', F, '2028-02-29 12:00:00'),
        ('not-a-leap-day', F, '2026-02-29 12:00:00'), ('month-13', F, '2026-13-01 00:00:00'), ('day-32', F, '2026-01-32 00:00:00'),
        ('hour-24', F, '2026-01-01 24:00:00'), ('minute-60', F, '2026-01-01 00:60:00'), ('second-59', F, '2026-01-01 00:00:59'),
        ('second-60', F, '2026-01-01 23:59:60'), ('second-61', F, '2026-01-01 23:59:61'), ('second-62', F, '2026-01-01 23:59:62'),
        ('one-digit-fields', F, '2026-9-1 1:2:3'), ('leading-space', F, ' 2026-09-21 14:13:20'), ('trailing-space', F, '2026-09-21 14:13:20 '),
        ('trailing-data', F, '2026-09-21 14:13:20 extra'), ('missing-seconds', F, '2026-09-21 14:13'), ('empty-text', F, ''),
        ('arabic-indic-digits', F, '\N{ARABIC-INDIC DIGIT TWO}\N{ARABIC-INDIC DIGIT ZERO}\N{ARABIC-INDIC DIGIT TWO}\N{ARABIC-INDIC DIGIT SIX}-09-21 14:13:20'),
        ('date-only', '%Y-%m-%d', '2026-09-21'), ('time-only-year-1900', '%H:%M:%S', '14:13:20'), ('year-only', '%Y', '2026'),
        ('year-month', '%Y-%m', '2026-09'), ('two-digit-year-26', '%y-%m-%d', '26-09-21'), ('two-digit-year-68', '%y-%m-%d', '68-01-01'),
        ('two-digit-year-69', '%y-%m-%d', '69-01-01'), ('two-digit-year-99', '%y-%m-%d', '99-01-01'), ('year-1969', '%Y-%m-%d', '1969-12-31'),
        ('year-1970', '%Y-%m-%d %H:%M:%S', '1970-01-01 00:00:00'), ('year-2038', '%Y-%m-%d %H:%M:%S', '2038-01-19 03:14:08'),
        ('year-3000', '%Y-%m-%d', '3000-01-01'), ('slashes-dmy', '%d/%m/%Y %H:%M', '21/09/2026 14:13'), ('slashes-mdy', '%m/%d/%y', '09/21/26'),
        ('abbrev-month', '%b %d %Y', 'Sep 21 2026'), ('full-month', '%B %d, %Y', 'September 21, 2026'), ('abbrev-month-lower', '%b %d %Y', 'sep 21 2026'),
        ('unknown-month', '%b %d %Y', 'Foo 21 2026'), ('weekday-abbrev', '%a %b %d %H:%M:%S %Y', 'Mon Sep 21 14:13:20 2026'),
        ('weekday-full', '%A %d %B %Y', 'Monday 21 September 2026'), ('weekday-ignored-for-mktime', '%a %Y-%m-%d', 'Fri 2026-09-21'),
        ('day-of-year', '%Y-%j', '2026-264'), ('day-of-year-366', '%Y-%j', '2026-366'), ('day-of-year-0', '%Y-%j', '2026-000'),
        ('twelve-hour-pm', '%Y-%m-%d %I:%M %p', '2026-09-21 02:13 PM'), ('twelve-hour-am', '%Y-%m-%d %I:%M %p', '2026-09-21 12:00 AM'),
        ('twelve-hour-noon', '%Y-%m-%d %I:%M %p', '2026-09-21 12:00 PM'), ('twelve-hour-13', '%Y-%m-%d %I:%M %p', '2026-09-21 13:00 PM'),
        ('am-lower', '%Y-%m-%d %I:%M %p', '2026-09-21 02:13 pm'), ('offset-plus', '%Y-%m-%d %H:%M:%S %z', '2026-09-21 14:13:20 +0700'),
        ('offset-minus', '%Y-%m-%d %H:%M:%S %z', '2026-09-21 14:13:20 -0500'), ('offset-z', '%Y-%m-%d %H:%M:%S %z', '2026-09-21 14:13:20 Z'),
        ('offset-colon', '%Y-%m-%d %H:%M:%S %z', '2026-09-21 14:13:20 +07:00'), ('offset-bad', '%Y-%m-%d %H:%M:%S %z', '2026-09-21 14:13:20 +7'),
        ('zone-utc', '%Y-%m-%d %H:%M:%S %Z', '2026-09-21 14:13:20 UTC'), ('zone-gmt', '%Y-%m-%d %H:%M:%S %Z', '2026-09-21 14:13:20 GMT'),
        ('zone-unknown', '%Y-%m-%d %H:%M:%S %Z', '2026-09-21 14:13:20 XYZ'), ('fraction', '%Y-%m-%d %H:%M:%S.%f', '2026-09-21 14:13:20.987654'),
        ('fraction-short', '%Y-%m-%d %H:%M:%S.%f', '2026-09-21 14:13:20.5'), ('fraction-long', '%Y-%m-%d %H:%M:%S.%f', '2026-09-21 14:13:20.1234567'),
        ('percent-literal', '%Y%%%m', '2026%09'), ('iso-t', '%Y-%m-%dT%H:%M:%S', '2026-09-21T14:13:20'), ('iso-t-with-z', '%Y-%m-%dT%H:%M:%SZ', '2026-09-21T14:13:20Z'),
        ('compact', '%Y%m%d%H%M%S', '20260921141320'), ('compact-short', '%Y%m%d%H%M%S', '2026092114132'),
        ('week-number-ignored', '%Y-%U-%w', '2026-38-1'), ('week-monday', '%Y-%W-%w', '2026-38-1'),
        ('literal-text', 'at %H:%M on %Y-%m-%d', 'at 14:13 on 2026-09-21'), ('whitespace-in-format', '%Y-%m-%d   %H', '2026-09-21 14'),
        ('format-without-directives', 'plain', 'plain'), ('format-mismatch', 'plain', 'other'),
    ]
    for name, fmt, text in rows:
        c.add(name, {'format': fmt, 'text': text}, run)
    return c.rows


# ---- pydumps ------------------------------------------------------------------------------------------------------------------

def pydumps(L, ctx):
    """Python json.dumps (default separators, ensure_ascii) of a JSON text; indent is null or an integer."""
    c = Cases()

    def run(i):
        return json.dumps(json.loads(i['text']), indent=i['indent'])

    texts = [
        ('empty-object', '{}'), ('empty-array', '[]'), ('nested-empty', '{"a": [], "b": {}, "c": [[], {}]}'), ('null', 'null'),
        ('booleans', '[true, false, null]'), ('integer', '42'), ('negative-integer', '-7'), ('zero', '0'), ('big-integer', '12345678901234567890'),
        ('integer-above-2-53', '9007199254740993'), ('float-one', '1.0'), ('float-negative-zero', '-0.0'), ('float-tenth', '0.1'),
        ('float-third', '0.3333333333333333'), ('float-exponent-large', '1e22'), ('float-exponent-small', '1E-7'), ('float-1e16', '1e16'),
        ('float-1e15', '1e15'), ('float-1e-5', '0.00001'), ('float-1e-4', '0.0001'), ('float-long', '123456789012345680000.0'),
        ('float-max', '1.7976931348623157e308'), ('float-min', '5e-324'), ('float-in-array', '[1.0, 2.50, 3e0]'),
        ('string-plain', '"abc"'), ('string-empty', '""'), ('string-quote-backslash', '"a\\"b\\\\c"'), ('string-slash', '"a/b"'),
        ('string-controls', '"\\u0000\\u0001\\b\\f\\n\\r\\t\\u001f\\u007f"'), ('string-e-acute', '"\\u00e9"'), ('string-raw-e-acute', '"' + E_ACUTE + '"'),
        ('string-bmp-cjk', '"\\u4e2d\\u6587"'), ('string-astral-escaped', '"\\ud83d\\ude00"'), ('string-astral-raw', '"' + EMOJI + '"'),
        ('string-line-separator', '"\\u2028\\u2029\\u0085"'), ('string-bom', '"\\ufeff"'), ('string-del-and-nbsp', '"\\u007f\\u00a0"'),
        ('string-lowercase-hex', '"\\u00ff\\uABCD"'), ('string-combining', '"e\\u0301"'),
        ('object-insertion-order', '{"b": 1, "a": 2, "c": 3}'), ('object-duplicate-keys', '{"a": 1, "b": 2, "a": 3}'),
        ('object-numeric-keys', '{"10": 1, "2": 2, "1": 3}'), ('object-unicode-keys', '{"' + E_ACUTE + '": 1, "\\u4e2d": 2}'),
        ('object-empty-key', '{"": 1}'), ('nested', '{"a": {"b": {"c": [1, {"d": null}]}}, "e": [[1, 2], [3]]}'),
        ('array-mixed', '[1, "a", null, true, 1.5, [], {}]'), ('deep-array', '[[[[[[1]]]]]]'),
        ('config-like', '{"schema_version": 1, "title": "x", "panels": {"git": false}, "session_rules": [{"match": "STEP=([A-Z])", "label": "step {1}"}]}'),
        ('whitespace-input', ' { "a" : [ 1 , 2 ] } '),
    ]
    for name, text in texts:
        for indent in (None, 2):
            c.add('%s-%s' % (name, 'compact' if indent is None else 'indent2'), {'text': text, 'indent': indent}, run)
    c.add('config-like-indent4', {'text': '{"a": {"b": [1, 2]}, "c": []}', 'indent': 4}, run)
    c.add('config-like-indent0', {'text': '{"a": {"b": [1, 2]}, "c": []}', 'indent': 0}, run)
    c.add('config-like-indent1', {'text': '{"a": {"b": [1, 2]}, "c": []}', 'indent': 1}, run)
    return c.rows


# ---- slug ---------------------------------------------------------------------------------------------------------------------

def slug(L, ctx):
    c = Cases()

    def run(i):
        fn = L.C.slugify if i['fn'] == 'slugify' else L.C.check_slug
        return _outcome(L, fn, i['arg'])

    for name, arg in [('plain', 'Nightly build'), ('steps', 'Nightly build: Steps A/B'), ('upper', 'ABC'), ('digits-first', '123 go'),
                      ('leading-trailing-symbols', '--Hello World--'), ('runs-of-symbols', 'a___b   c...d'), ('empty', ''), ('only-symbols', '!!!'),
                      ('only-spaces', '   '), ('non-ascii', 'caf' + E_ACUTE + ' ' + EMOJI), ('cjk', '\N{CJK UNIFIED IDEOGRAPH-4E2D}\N{CJK UNIFIED IDEOGRAPH-6587}'),
                      ('turkish-dotless', 'I\N{LATIN SMALL LETTER DOTLESS I}'), ('long-48', 'a' * 48), ('long-49', 'a' * 49), ('long-cut-ends-with-hyphen', 'a' * 47 + '-b'),
                      ('long-cut-inside-hyphens', 'a' * 46 + '---b'), ('long-100-words', ' '.join(['word'] * 30)), ('reserved-con', 'CON'),
                      ('reserved-nul-dot', 'nul.txt'), ('mixed-case-symbols', 'Release_2.0 (final)'), ('null', None), ('zero', 0), ('false', False),
                      ('number', 5), ('list', ['a']), ('dict', {'a': 1})]:
        c.add('slugify-' + name, {'fn': 'slugify', 'arg': arg}, run)
    for name, arg in [('valid', 'nightly-build'), ('valid-digit-first', '1a'), ('valid-single', 'a'), ('valid-48', 'a' * 48), ('too-long-49', 'a' * 49),
                      ('leading-hyphen', '-a'), ('trailing-hyphen', 'a-'), ('double-hyphen', 'a--b'), ('upper', 'Abc'), ('underscore', 'a_b'), ('dot', 'a.b'),
                      ('space', 'a b'), ('empty', ''), ('con', 'con'), ('nul', 'nul'), ('prn', 'prn'), ('aux', 'aux'), ('com1', 'com1'), ('lpt1', 'lpt1'),
                      ('con-upper', 'CON'), ('con-prefix', 'console'), ('newline-end', 'abc\n'), ('unicode', 'caf' + E_ACUTE), ('null', None), ('number', 5),
                      ('list', ['a'])]:
        c.add('check_slug-' + name, {'fn': 'check_slug', 'arg': arg}, run)
    return c.rows


# ---- merge and provenance ------------------------------------------------------------------------------------------------------

def merge_provenance(L, ctx):
    c = Cases()

    def run(i):
        m = _outcome(L, L.C.merge, i['base'], i['over'])
        p = _outcome(L, L.C.provenance, i['base'], i['over'], i['source'])
        return {'merged': m, 'provenance': p}

    d = L.C.load_defaults()
    small = {'title': 'T', 'port': 1, 'panels': {'a': True, 'b': False}, 'ui': {'theme': 'auto'}, 'poll': {'x': 1}, 'limits': {'y': 2},
             'session_rules': [{'match': 'A'}], 'chain_log': None}
    cases = [
        ('empty-over', small, {}, 'task'), ('empty-base', {}, {'title': 'x', 'panels': {'a': 1}}, 'task'),
        ('scalar-override', small, {'title': 'U', 'port': 2}, 'task'), ('panels-merge-per-key', small, {'panels': {'b': True, 'c': True}}, 'task'),
        ('panels-empty-dict', small, {'panels': {}}, 'task'), ('panels-null-replaces', small, {'panels': None}, 'legacy'),
        ('panels-list-replaces', small, {'panels': [1]}, 'legacy'), ('panels-int-provenance-raises', small, {'panels': 5}, 'task'),
        ('ui-poll-limits-merge', small, {'ui': {'density': 'compact'}, 'poll': {'z': 3}, 'limits': {'y': 9}}, 'task'),
        ('list-replaced-not-merged', small, {'session_rules': [{'match': 'B'}, {'match': 'C'}]}, 'task'),
        ('underscore-keys-skipped', small, {'_comment': 'x', 'title': 'U'}, 'task'), ('unknown-key-added', small, {'brand_new': 1}, 'legacy'),
        ('null-value-replaces', small, {'chain_log': 'log.txt', 'title': None}, 'task'), ('base-lacks-merged-dict', {'title': 'x'}, {'panels': {'a': True}}, 'task'),
        ('over-dict-for-scalar-key', small, {'title': {'a': 1}}, 'task'), ('nested-values-copied', {'panels': {'a': {'deep': [1, 2]}}}, {'panels': {'a': {'deep': [3]}}}, 'task'),
        ('source-legacy', small, {'port': 9}, 'legacy'), ('source-odd-name', small, {'port': 9}, 'weird source'),
        ('real-defaults-empty', d, {}, 'task'), ('real-defaults-panels', d, {'panels': {'git': False, 'machine': False}, 'window_hours': 12}, 'task'),
    ]
    for name, base, over, source in cases:
        c.add(name, {'base': base, 'over': over, 'source': source}, run)
    return c.rows


# ---- audit_entry --------------------------------------------------------------------------------------------------------------

def audit_entry(L, ctx):
    """tasks.audit_change / record_decision on a fresh workspace folder, each call at its own frozen instant."""
    c = Cases()
    counter = [0]

    def run(i):
        counter[0] += 1
        d = os.path.join(ctx['tmp'], 'audit-%d' % counter[0])
        for rel, text in (i.get('initial') or {}).items():
            p = os.path.join(d, *rel.split('/'))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.write(text.encode('utf-8'))
        os.makedirs(d, exist_ok=True)
        for call in i['calls']:
            with D.clock_at(call['now']):
                if call['fn'] == 'audit_change':
                    a = call['args']
                    kw = {'unresolved': a['unresolved']} if 'unresolved' in a else {}
                    L.tasks.audit_change(d, a['action'], a['summary'], a['reason'], a['files'], a['validation'], a['outcome'], **kw)
                else:
                    a = call['args']
                    kw = {'rejected': a['rejected']} if 'rejected' in a else {}
                    L.tasks.record_decision(d, a['title'], a['decision'], **kw)

        def read(rel):
            try:
                with open(os.path.join(d, 'audit', rel), 'rb') as f:
                    return f.read().decode('utf-8')
            except OSError:
                return None
        return {'changes.md': read('changes.md'), 'decisions.md': read('decisions.md'), 'last_change': L.tasks.last_change(d)}

    def chg(now, **a):
        base = {'action': 'configure', 'summary': 'window_hours: (default 8) -> 12', 'reason': 'owner asked', 'files': ['config.json'],
                'validation': 'schema ok (strict)', 'outcome': 'applied'}
        base.update(a)
        return {'fn': 'audit_change', 'now': now, 'args': base}

    def dec(now, **a):
        base = {'title': 'configuration', 'decision': 'use the chain log'}
        base.update(a)
        return {'fn': 'record_decision', 'now': now, 'args': base}

    cases = [
        ('change-first-entry', {'calls': [chg(NOW)]}),
        ('change-two-entries', {'calls': [chg(NOW), chg(NOW + 61, summary='second', files=['config.json', 'task.json'])]}),
        ('change-empty-reason-and-files', {'calls': [chg(NOW, reason='', files=[])]}),
        ('change-unresolved-given', {'calls': [chg(NOW, unresolved='follow up on the port')]}),
        ('change-multi-file-list', {'calls': [chg(NOW, files=['a', 'b', 'c'])]}),
        ('change-non-ascii', {'calls': [chg(NOW, summary='caf' + E_ACUTE + ' ' + EMOJI, reason='\N{CJK UNIFIED IDEOGRAPH-4E2D}')]}),
        ('change-newline-in-summary', {'calls': [chg(NOW, summary='line one\nline two')]}),
        ('change-pipe-in-action', {'calls': [chg(NOW, action='a | b')]}),
        ('decision-first-entry', {'calls': [dec(NOW)]}),
        ('decision-rejected-empty', {'calls': [dec(NOW, rejected='')]}),
        ('decision-rejected-given', {'calls': [dec(NOW + 5, title='Use attempts', decision='chain log', rejected='none')]}),
        ('decision-two-entries', {'calls': [dec(NOW), dec(NOW + 3600, title='second')]}),
        ('both-files', {'calls': [chg(NOW), dec(NOW + 1), chg(NOW + 2, summary='third')]}),
        ('clock-other-day', {'calls': [chg(1767225600)]}),
        ('clock-fraction-truncated', {'calls': [chg(NOW + 0.999)]}),
        ('existing-file-no-header-added', {'initial': {'audit/changes.md': '# Changes\n\n## 2026-01-01T00:00:00Z | init-task\n- Summary: created\n\n'},
                                           'calls': [chg(NOW)]}),
        ('last-change-without-calls', {'initial': {'audit/changes.md': '# Changes\n\n## 2026-01-01T00:00:00Z | init-task\n- Summary: created task\n- Reason: r\n\n'}, 'calls': []}),
        ('last-change-no-summary-line', {'initial': {'audit/changes.md': '# Changes\n\n## 2026-01-01T00:00:00Z | init-task\n- Reason: r\n\n'}, 'calls': []}),
        ('last-change-empty-file', {'initial': {'audit/changes.md': ''}, 'calls': []}),
        ('last-change-header-only', {'initial': {'audit/changes.md': '# Changes\n\n'}, 'calls': []}),
        ('no-calls-no-files', {'calls': []}),
    ]
    for name, inp in cases:
        inp.setdefault('calls', [])
        c.add(name, inp, run)
    return c.rows


# ---- json_atomic --------------------------------------------------------------------------------------------------------------

def json_atomic(L, ctx):
    """Bytes (base64) of config.write_json_atomic: indent 2, ensure_ascii False, key order kept, LF, one trailing LF, no .tmp left."""
    c = Cases()
    counter = [0]

    def run(i):
        counter[0] += 1
        p = os.path.join(ctx['tmp'], 'atomic-%d.json' % counter[0])
        L.C.write_json_atomic(p, json.loads(i['text']))
        if os.path.exists(p + '.tmp'):
            raise RuntimeError('write_json_atomic left a .tmp file')
        with open(p, 'rb') as f:
            return base64.b64encode(f.read()).decode('ascii')

    texts = [('empty-object', '{}'), ('empty-array', '[]'), ('scalar-string', '"x"'), ('scalar-null', 'null'), ('simple', '{"a": 1, "b": [1, 2]}'),
             ('key-order-kept', '{"z": 1, "a": 2, "m": {"y": 1, "b": 2}}'), ('nested-empty', '{"a": [], "b": {}, "c": [[], {}]}'),
             ('non-ascii-raw', '{"t": "caf\\u00e9 \\u4e2d\\u6587 \\ud83d\\ude42"}'), ('line-separators', '{"t": "\\u2028\\u2029\\u0085"}'),
             ('control-characters', '{"t": "\\u0000\\u0001\\n\\r\\t\\u001f\\u007f"}'), ('quotes-slash', '{"t": "a\\"b\\\\c/d"}'),
             ('floats', '{"a": 1.0, "b": 0.1, "c": 1e22, "d": 1E-7, "e": -0.0}'), ('big-integer', '{"n": 12345678901234567890}'),
             ('booleans-null', '{"a": true, "b": false, "c": null}'), ('task-json-like', '{"schema_version": 1, "id": "x", "name": "N", "description": "",'
                                                                                            ' "created": "2026-09-21T14:13:20Z", "repo": "../../../..", "links": []}'),
             ('config-like', '{"schema_version": 1, "title": "x", "panels": {"git": false}, "session_rules": [{"match": "STEP=([A-Z])", "label": "step {1}"}]}'),
             ('deep', '[[[[{"a": [[]]}]]]]')]
    for name, text in texts:
        c.add(name, {'text': text}, run)
    return c.rows


# ---- external_state -----------------------------------------------------------------------------------------------------------

def external_state(L, ctx):
    c = Cases()

    def run(i):
        return _outcome(L, L.state.external_state, i['row'])

    exits = ['0', 0, '', None, '1', '00', 'x']
    statuses = [None, '', ' ', 'PASS', ' pass ', 'Passed', 'DONE', 'ok', 'OKAY', 'COMPLETE', 'COMPLETEDX', 'SUCCESS', 'FAIL', 'failed', 'BLOCKED',
                'abort', 'nopass', 'PASS (FAIL)', 'RUNNING', 'x', '  DONE  ']
    for ei, ex in enumerate(exits):
        for si, st in enumerate(statuses):
            c.add('grid-e%02d-s%02d' % (ei, si), {'row': {'end': NOW, 'exit': ex, 'status': st}}, run)
    c.add('row-none', {'row': None}, run)
    c.add('end-none-with-failure', {'row': {'end': None, 'exit': '1', 'status': 'FAIL'}}, run)
    c.add('end-none', {'row': {'end': None, 'exit': None, 'status': None}}, run)
    c.add('end-missing', {'row': {'exit': '0', 'status': 'PASS'}}, run)
    c.add('end-zero-is-not-none', {'row': {'end': 0, 'exit': '0', 'status': 'PASS'}}, run)
    c.add('end-empty-string-is-not-none', {'row': {'end': '', 'exit': '1', 'status': ''}}, run)
    c.add('exit-missing-status-pass', {'row': {'end': NOW, 'status': 'PASS'}}, run)
    c.add('exit-missing-status-missing', {'row': {'end': NOW}}, run)
    c.add('empty-row', {'row': {}}, run)
    c.add('status-number-raises', {'row': {'end': NOW, 'exit': '0', 'status': 5}}, run)
    c.add('status-list-raises', {'row': {'end': NOW, 'exit': '0', 'status': ['PASS']}}, run)
    c.add('exit-list-nonzero', {'row': {'end': NOW, 'exit': [0], 'status': 'PASS'}}, run)
    c.add('status-non-ascii', {'row': {'end': NOW, 'exit': '0', 'status': 'PASS ' + EMOJI}}, run)
    c.add('status-multiline-fail-inside', {'row': {'end': NOW, 'exit': '0', 'status': 'PASS\nFAIL later'}}, run)
    c.add('status-leading-newline-pass', {'row': {'end': NOW, 'exit': '0', 'status': '\nPASS'}}, run)
    c.add('extra-keys-ignored', {'row': {'end': NOW, 'exit': '0', 'status': 'PASS', 'part': 'A', 'sid': 'x', 'state': 'RUNNING'}}, run)
    return c.rows


# ---- classify_state -----------------------------------------------------------------------------------------------------------

def classify_state(L, ctx):
    """state.classify_state with every branch and the boundary seconds. Inputs are the function's own arguments."""
    c = Cases()

    def run(i):
        return _outcome(L, lambda: list(L.state.classify_state(**i)))

    def case(name, age=600.0, active=120, last_stop='end_turn', pending=0, waited=None, agents=(), grace=900, registry=None, external=None,
             has_records=True):
        """age: seconds since the transcript was written; waited: seconds since the oldest pending tool call (None = no timestamp)."""
        c.add(name, {'now': NOW, 'mtime': NOW - age, 'active_seconds': active, 'last_stop': last_stop, 'pending': pending,
                     'oldest_pending_ts': 0 if waited is None else NOW - waited, 'agent_mtimes': [NOW - a for a in agents],
                     'grace_seconds': grace, 'registry': registry, 'external': external, 'has_records': has_records}, run)

    for age in (-1.5, -0.5, 0, 0.5, 59.5, 119, 119.5, 119.75, 119.999, 120, 120.25, 121, 599.5, 600, 3599.5, 3600, 86400, 100000.5):
        case('age-%s' % age, age=age)
    for stop in ('end_turn', 'stop_sequence', 'tool_use', 'max_tokens', '', None, 'refusal', 'pause_turn', 'END_TURN', 'model_context_window_exceeded'):
        case('last-stop-%s' % (stop,), age=600, last_stop=stop)
    for waited in (None, 0, 1, 599.5, 600, 899, 899.5, 899.75, 900, 900.25, 901, 3599, 3599.5, 3600, 3661.5, 7200, 100000, -30):
        case('pending-1-waited-%s' % waited, age=600, pending=1, waited=waited)
    for waited in (None, 500, 899.5, 900, 3600):
        case('pending-3-waited-%s' % waited, age=600, pending=3, waited=waited)
    for age in (1000, 3000.5, 100000):
        case('pending-no-timestamp-age-%s' % age, age=age, pending=2, waited=None)
    case('pending-while-writing', age=5, pending=2, waited=2000)
    case('pending-registry-idle-within-grace', age=600, pending=1, waited=30, registry={'status': 'idle'})
    case('pending-registry-idle-stalled', age=600, pending=1, waited=3000, registry={'status': 'idle'})
    for agents in ([], [59], [59.5], [59.999], [60], [60.5], [61], [30, 100], [10, 20, 30], [-5], [0], [600, 700]):
        case('agents-%s' % (agents,), age=600, agents=agents)
    case('agents-beat-pending', age=600, agents=[10], pending=2, waited=5000)
    case('agents-beat-registry-idle', age=600, agents=[10], registry={'status': 'idle'})
    case('agents-while-writing', age=5, agents=[10, 20])
    for name, reg in [('busy', {'status': 'busy'}), ('busy-extra-keys', {'status': 'busy', 'pid': 1, 'kind': 'cli'}), ('idle', {'status': 'idle'}),
                      ('waiting', {'status': 'waiting', 'waitingFor': 'permission prompt'}), ('bogus', {'status': 'bogus'}), ('empty', {}), ('none', None),
                      ('status-null', {'status': None}), ('status-case', {'status': 'BUSY'})]:
        case('registry-%s-quiet' % name, age=5000, registry=reg)
        case('registry-%s-fresh' % name, age=5, registry=reg)
    case('registry-busy-no-records', age=5000, registry={'status': 'busy'}, has_records=False)
    case('external-completed', external={'state': 'COMPLETED', 'evidence': 'chain log: exit=0 status=PASS'})
    case('external-failed-fresh', age=0, external={'state': 'FAILED', 'evidence': 'chain log: exit=1 status=FAIL'})
    case('external-beats-no-records', has_records=False, external={'state': 'UNKNOWN', 'evidence': 'x'})
    case('external-beats-registry-busy', registry={'status': 'busy'}, external={'state': 'COMPLETED', 'evidence': 'y'})
    case('external-empty-dict-is-falsy', external={})
    case('external-none', external=None)
    case('no-records-fresh', age=0, has_records=False)
    case('no-records-old', age=100000, has_records=False, pending=3, waited=5)
    for active, age in ((1, 0.5), (1, 1), (1, 1.5), (0.5, 0.25), (0.5, 0.5), (0, 0), (0, -1), (3600, 3599), (3600, 3600), (120.5, 120.25), (120.5, 120.75)):
        case('active-%s-age-%s' % (active, age), age=age, active=active)
    for grace, waited in ((1, 0.5), (1, 1), (1, 1.5), (0.5, 0.25), (0.5, 0.5), (60, 59), (60, 60), (60, 119), (60, 120), (60, 3599)):
        case('grace-%s-waited-%s' % (grace, waited), age=600, pending=1, waited=waited, grace=grace)
    for stop in ('end_turn', None):
        for age in (59.5, 60, 61, 119.5, 6000.5, 100000):
            case('quiet-minutes-%s-%s' % (stop, age), age=age, last_stop=stop, active=1)
    return c.rows


# ---- clip ---------------------------------------------------------------------------------------------------------------------

def clip(L, ctx):
    """reader.clip(s, n): code-point clip with a marker; non-strings are dumped with json.dumps(ensure_ascii=False) first."""
    c = Cases()

    def run(i):
        v = json.loads(i['value_json']) if 'value_json' in i else i['value']
        return _outcome(L, L.reader.clip, v, i['n'])

    def s(name, value, n):
        c.add(name, {'value': value, 'n': n}, run)

    def j(name, text, n):
        c.add(name, {'value_json': text, 'n': n}, run)

    s('ascii-shorter', 'hello', 10)
    s('ascii-equal', 'hello', 5)
    s('ascii-one-over', 'hello', 4)
    s('ascii-over', 'hello world', 5)
    s('empty-string', '', 5)
    s('empty-string-n0', '', 0)
    s('n-zero', 'abc', 0)
    s('n-one', 'abc', 1)
    s('n-negative', 'abcdef', -1)
    s('n-large', 'abc', 1000000)
    s('spaces-kept', '  a b  ', 4)
    s('newlines-kept', 'a\nb\nc', 3)
    s('emoji-fits', 'ab' + EMOJI, 3)
    s('emoji-cut-after', 'ab' + EMOJI + 'cd', 3)
    s('emoji-cut-before', 'ab' + EMOJI + 'cd', 2)
    s('emoji-only-two', EMOJI * 2, 1)
    s('astral-count-code-points', EMOJI * 10, 4)
    s('combining-fits', 'e' + COMBINING_ACUTE + 'x', 3)
    s('combining-separated', 'e' + COMBINING_ACUTE + 'x', 1)
    s('precomposed-vs-combining', E_ACUTE + 'e' + COMBINING_ACUTE, 2)
    s('zwj-sequence', FAMILY + 'x', 3)
    s('zwj-sequence-fits', FAMILY, 5)
    s('bmp-cjk', '\N{CJK UNIFIED IDEOGRAPH-4E2D}\N{CJK UNIFIED IDEOGRAPH-6587}abc', 2)
    s('long-5999-emoji-6001', 'y' * 5999 + EMOJI + 'z', 6000)
    s('long-160-emoji-boundary', 'x' * 159 + EMOJI + 'tail', 160)
    s('marker-count-large', 'a' * 1234, 10)
    s('string-null-text', 'null', 2)
    c.add('none', {'value': None, 'n': 10}, run)
    c.add('none-n0', {'value': None, 'n': 0}, run)
    c.add('true', {'value': True, 'n': 10}, run)
    c.add('false-cut', {'value': False, 'n': 2}, run)
    c.add('int', {'value': 12345, 'n': 3}, run)
    c.add('negative-int', {'value': -7, 'n': 10}, run)
    c.add('empty-list', {'value': [], 'n': 10}, run)
    c.add('list', {'value': [1, 'a', None, True], 'n': 100}, run)
    c.add('list-cut', {'value': [1, 'a', None, True], 'n': 5}, run)
    c.add('empty-dict', {'value': {}, 'n': 10}, run)
    c.add('dict', {'value': {'a': 1, 'b': [1, 2], 'c': {'d': None}}, 'n': 100}, run)
    c.add('dict-cut', {'value': {'a': 1, 'b': [1, 2], 'c': {'d': None}}, 'n': 12}, run)
    c.add('dict-non-ascii-not-escaped', {'value': {'k': 'caf' + E_ACUTE + EMOJI}, 'n': 100}, run)
    c.add('dict-non-ascii-cut', {'value': {'k': EMOJI * 6}, 'n': 9}, run)
    c.add('dict-with-quotes', {'value': {'a': 'x"y\\z\n'}, 'n': 100}, run)
    j('float-one', '1.0', 10)
    j('float-tenth', '0.1', 10)
    j('float-exponent', '1e22', 10)
    j('float-negative-zero', '-0.0', 10)
    j('float-in-list', '[1.5, 2.0]', 100)
    j('integer-big', '12345678901234567890', 10)
    j('dict-insertion-order', '{"b": 1, "a": 2}', 100)
    j('dict-duplicate-keys', '{"a": 1, "b": 2, "a": 3}', 100)
    j('dict-numeric-keys-order', '{"10": 1, "2": 2}', 100)
    return c.rows


# ---- events_of ----------------------------------------------------------------------------------------------------------------

def events_of(L, ctx):
    """reader.events_of(record, text_chars) for the record shapes of transcript-survey section 8 items 1-18, reduced to the
    fields the legacy function reads; strings are made up."""
    c = Cases()
    T = '2026-09-21T14:00:00.000Z'

    def run(i):
        return _outcome(L, L.reader.events_of, i['record'], i['text_chars'])

    def ev(name, record, text_chars=6000):
        c.add(name, {'record': record, 'text_chars': text_chars}, run)

    def user(content, **extra):
        r = {'type': 'user', 'timestamp': T, 'message': {'role': 'user', 'content': content}}
        r.update(extra)
        return r

    def asst(blocks, **extra):
        r = {'type': 'assistant', 'timestamp': T, 'message': {'id': 'msg_x', 'role': 'assistant', 'content': blocks}}
        r.update(extra)
        return r

    def tool(inp, name='Bash', tid='toolu_1'):
        b = {'type': 'tool_use', 'id': tid, 'name': name, 'input': inp}
        return asst([b])

    def result(content, tid='toolu_1', **extra):
        b = {'type': 'tool_result', 'tool_use_id': tid, 'content': content}
        b.update(extra)
        return user([b])

    ev('prompt-string', user('hello'))
    ev('prompt-empty-string', user(''))
    ev('prompt-blocks', user([{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}]))
    ev('prompt-non-dict-blocks', user(['x', 5, None, {'type': 'text', 'text': 'ok'}]))
    ev('prompt-text-missing', user([{'type': 'text'}]))
    ev('prompt-text-integer', user([{'type': 'text', 'text': 5}]))
    ev('prompt-text-null', user([{'type': 'text', 'text': None}]))
    ev('prompt-unknown-block-type', user([{'type': 'image', 'source': {}}, {'type': 'text', 'text': 'after'}]))
    ev('prompt-clipped', user('abcdefghijklmnopqrstuvwxyz'), 10)
    ev('prompt-clip-emoji-code-points', user('abcd' + EMOJI + 'ef'), 5)
    ev('prompt-clip-zero', user('abc'), 0)
    ev('prompt-no-timestamp', {'type': 'user', 'message': {'content': 'x'}})
    ev('prompt-null-timestamp', {'type': 'user', 'timestamp': None, 'message': {'content': 'x'}})
    ev('prompt-empty-timestamp', {'type': 'user', 'timestamp': '', 'message': {'content': 'x'}})
    ev('user-content-null', user(None))
    ev('user-content-object', user({'a': 1}))
    ev('user-content-number', user(5))
    ev('user-message-not-an-object', {'type': 'user', 'timestamp': T, 'message': 'x'})
    ev('user-message-missing', {'type': 'user', 'timestamp': T})
    ev('user-compact-summary', user('This session is being continued from a previous conversation...', isCompactSummary=True, isVisibleInTranscriptOnly=True))
    ev('user-subagent-first-record', user('Review the module', parentUuid=None, isSidechain=True, agentId='aaa111'))
    ev('user-task-notification', user('<task-notification><task-id>t1</task-id><status>completed</status></task-notification>', origin={'kind': 'task-notification'}))
    ev('user-interrupt', user([{'type': 'text', 'text': '[Request interrupted by user]'}], interruptedMessageId='msg_x'))
    ev('user-interrupt-for-tool-use', user([{'type': 'text', 'text': '[Request interrupted by user for tool use]'}]))
    ev('result-string', result('done'))
    ev('result-list-of-texts', result([{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}]))
    ev('result-list-with-non-dicts', result([{'type': 'text', 'text': 'a'}, 'str', 5, None, {'type': 'image'}]))
    ev('result-list-of-strings', result(['a', 'b']))
    ev('result-empty-list', result([]))
    ev('result-none', result(None))
    ev('result-empty-string', result(''))
    ev('result-zero', result(0))
    ev('result-integer', result(5))
    ev('result-object', result({'k': 'v'}))
    ev('result-error-true', result('boom', is_error=True))
    ev('result-error-false', result('fine', is_error=False))
    ev('result-error-truthy-string', result('x', is_error='yes'))
    ev('result-error-null', result('x', is_error=None))
    ev('result-denial', result("The user doesn't want to proceed with this tool use.", is_error=True, toolDenialKind='user-rejected',
                               permissionDecision={'decision': 'reject', 'source': 'user'}))
    ev('result-no-tool-use-id', user([{'type': 'tool_result', 'content': 'x'}]))
    ev('result-with-tool-use-result-object', user([{'type': 'tool_result', 'tool_use_id': 't', 'content': 'x', 'is_error': False}],
                                                  toolUseResult={'stdout': 'x'}, sourceToolAssistantUUID='u'))
    ev('result-clipped', result('abcdefghijklmnop'), 8)
    ev('result-text-and-prompt-order', user([{'type': 'tool_result', 'tool_use_id': 'a', 'content': 'r1'}, {'type': 'text', 'text': 'then text'},
                                             {'type': 'tool_result', 'tool_use_id': 'b', 'content': 'r2', 'is_error': True}]))
    ev('say-text', asst([{'type': 'text', 'text': 'I will run the tests.'}]))
    ev('say-blank-skipped', asst([{'type': 'text', 'text': ' \n '}]))
    ev('say-empty-skipped', asst([{'type': 'text', 'text': ''}]))
    ev('say-non-string-skipped', asst([{'type': 'text', 'text': 5}]))
    ev('say-spaces-kept', asst([{'type': 'text', 'text': '  padded  '}]))
    ev('say-clipped', asst([{'type': 'text', 'text': 'x' * 30}]), 12)
    ev('assistant-content-string', asst('plain string content'))
    ev('assistant-content-null', asst(None))
    ev('assistant-message-missing', {'type': 'assistant', 'timestamp': T})
    ev('assistant-non-dict-blocks', asst(['x', 1, None, {'type': 'text', 'text': 'ok'}]))
    ev('assistant-unknown-block', asst([{'type': 'redacted_thinking', 'data': 'x'}, {'type': 'server_tool_use', 'id': 's'}]))
    ev('assistant-three-blocks', asst([{'type': 'thinking', 'thinking': 'plan'}, {'type': 'text', 'text': 'say'},
                                       {'type': 'tool_use', 'id': 't', 'name': 'Read', 'input': {'file_path': 'a.txt'}}]))
    for key in ('command', 'file_path', 'pattern', 'description', 'prompt', 'script'):
        ev('tool-summary-key-' + key, tool({key: 'value of ' + key}))
    ev('tool-summary-priority', tool({'prompt': 'p', 'script': 's', 'description': 'd', 'pattern': 'pa', 'file_path': 'f', 'command': 'c'}))
    ev('tool-summary-empty-command-falls-through', tool({'command': '', 'file_path': 'f.txt'}))
    ev('tool-summary-none-command-falls-through', tool({'command': None, 'pattern': 'p'}))
    ev('tool-summary-no-known-key', tool({'other': 'x'}))
    ev('tool-summary-empty-input', tool({}))
    ev('tool-summary-first-line-only', tool({'command': 'echo one\necho two'}))
    ev('tool-summary-leading-newline', tool({'command': '\nabc'}))
    ev('tool-summary-crlf-line', tool({'command': 'first\r\nsecond'}))
    ev('tool-summary-clipped-160', tool({'command': 'c' * 170}))
    ev('tool-summary-emoji-at-160', tool({'command': 'x' * 159 + EMOJI + 'tail'}))
    ev('tool-summary-list-repr', tool({'command': ['a', 'b']}))
    ev('tool-summary-integer', tool({'command': 5}))
    ev('tool-summary-true-repr', tool({'command': True}))
    ev('tool-summary-dict-repr', tool({'command': {'a': 1}}))
    ev('tool-summary-empty-list-falls-through', tool({'command': [], 'file_path': 'f'}))
    ev('tool-summary-non-ascii', tool({'command': 'echo caf' + E_ACUTE + ' ' + EMOJI}))
    ev('tool-input-not-an-object-list', asst([{'type': 'tool_use', 'id': 't', 'name': 'Bash', 'input': ['x']}]))
    ev('tool-input-missing', asst([{'type': 'tool_use', 'id': 't', 'name': 'Bash'}]))
    ev('tool-input-string', asst([{'type': 'tool_use', 'id': 't', 'name': 'Bash', 'input': 'x'}]))
    ev('tool-name-missing', asst([{'type': 'tool_use', 'id': 't', 'input': {'command': 'x'}}]))
    ev('tool-name-empty', asst([{'type': 'tool_use', 'id': 't', 'name': '', 'input': {'command': 'x'}}]))
    ev('tool-id-missing', asst([{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'x'}}]))
    ev('tool-input-non-ascii-not-escaped', tool({'command': 'x', 'note': E_ACUTE + EMOJI}))
    ev('tool-input-clipped-4000', tool({'command': 'x', 'blob': 'z' * 4100}))
    ev('tool-input-key-order-sorted', tool({'a': 1, 'b': 2, 'command': 'c'}))
    ev('tool-agent-launch', tool({'description': 'security review', 'prompt': 'review the diff', 'run_in_background': True, 'subagent_type': 'general'}, name='Agent'))
    ev('tool-workflow', tool({'workflow': 'review', 'args': {}}, name='Workflow'))
    ev('tool-subagent-handback', tool({'summary': 'done'}, name='SubagentHandback'))
    ev('tool-structured-output', tool({'answer': 1}, name='StructuredOutput'))
    ev('thinking-text', asst([{'type': 'thinking', 'thinking': 'let me think'}]))
    ev('thinking-empty-skipped', asst([{'type': 'thinking', 'thinking': ''}]))
    ev('thinking-missing-skipped', asst([{'type': 'thinking'}]))
    ev('thinking-whitespace-kept', asst([{'type': 'thinking', 'thinking': ' '}]))
    ev('thinking-integer', asst([{'type': 'thinking', 'thinking': 5}]))
    ev('thinking-clipped-1500', asst([{'type': 'thinking', 'thinking': 't' * 1600}]))
    ev('thinking-ignores-text-chars', asst([{'type': 'thinking', 'thinking': 't' * 40}]), 10)
    ev('synthetic-api-error', {'type': 'assistant', 'timestamp': T, 'isApiErrorMessage': True, 'apiErrorStatus': 529, 'error': 'server_error',
                                'message': {'id': 'abc', 'model': '<synthetic>', 'role': 'assistant', 'stop_reason': 'stop_sequence',
                                            'content': [{'type': 'text', 'text': 'API Error: 529 overloaded'}],
                                            'usage': {'input_tokens': 0, 'output_tokens': 0, 'service_tier': None}}})
    ev('aborted-mid-stream', asst([{'type': 'text', 'text': 'partial answ'}], isAbortedMidStream=True))
    ev('parallel-tool-first', asst([{'type': 'tool_use', 'id': 'p1', 'name': 'Read', 'input': {'file_path': 'a'}}]))
    ev('parallel-tool-results', user([{'type': 'tool_result', 'tool_use_id': 'p1', 'content': 'A'}]))
    ev('turn-duration-system', {'type': 'system', 'subtype': 'turn_duration', 'timestamp': T, 'durationMs': 1000, 'messageCount': 4,
                                 'pendingBackgroundAgentCount': 2, 'pendingWorkflowCount': 1})
    ev('compact-boundary-system', {'type': 'system', 'subtype': 'compact_boundary', 'timestamp': T, 'parentUuid': None,
                                    'compactMetadata': {'trigger': 'auto', 'preTokens': 100}})
    ev('system-with-message-content', {'type': 'system', 'timestamp': T, 'message': {'content': [{'type': 'text', 'text': 'x'}]}})
    for typ in ('last-prompt', 'ai-title', 'custom-title', 'agent-name', 'mode', 'permission-mode', 'queue-operation', 'file-history-snapshot',
                'file-history-delta', 'bridge-session', 'atis-latch', 'cost-state', 'continued-in', 'summary', 'attachment', 'progress', 'pr-link'):
        ev('bookkeeping-' + typ, {'type': typ, 'timestamp': T, 'content': 'x', 'message': {'content': [{'type': 'text', 'text': 'x'}]}})
    ev('attachment-hook-success', {'type': 'attachment', 'timestamp': T, 'attachment': {'type': 'hook_success', 'hookName': 'PostToolUse'}})
    ev('attachment-queued-command', {'type': 'attachment', 'timestamp': T, 'attachment': {'type': 'queued_command', 'prompt': 'later', 'commandMode': 'prompt'}})
    ev('no-type', {'timestamp': T, 'message': {'content': 'x'}})
    ev('type-null', {'type': None, 'timestamp': T, 'message': {'content': 'x'}})
    ev('type-unknown', {'type': 'brand-new-type', 'timestamp': T, 'message': {'content': 'x'}})
    ev('empty-record', {})
    return c.rows


# ---- classify_rules -----------------------------------------------------------------------------------------------------------

def classify_rules(L, ctx):
    """Session-rule matrix (design 06 5.7). Rule cases run sessions.classify on the transcript the `rules` scenario built;
    attempts cases run panels.attempts_rows over crafted chain-log lines. Python outcomes only; Node expectations live in 06 5.7."""
    c = Cases()
    by_case = {x['case']: x for x in ctx['rules']['cases']}

    def run_rule(i):
        path = by_case[i['case']]['path']
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            label, matched = L.sessions.classify({'session_rules': i['rules']}, path)
            problems = L.C.validate({'session_rules': i['rules']}, strict=False)
        return {'label': label, 'matched': matched, 'problems': problems}

    for cid, title, rules, lines in P.RULE_CASES:
        c.add(cid, {'case': cid, 'kind': 'rules', 'title': title, 'rules': rules, 'lines': lines}, run_rule)

    def run_attempts(i):
        d = os.path.join(ctx['tmp'], 'attempts-' + i['case'])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'chain.log'), 'wb') as f:
            f.write(('\n'.join(i['chain_lines']) + '\n').encode('utf-8'))
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            rows = L.panels.attempts_rows({'attempts': i['attempts'], 'chain_log': 'chain.log', 'repo': d}, [])
        return rows

    for cid, title, acfg, lines in P.ATTEMPT_CASES:
        c.add(cid, {'case': cid, 'kind': 'attempts', 'title': title, 'attempts': acfg, 'chain_lines': lines}, run_attempts)
    return c.rows


# ---- registry of vector files ------------------------------------------------------------------------------------------------

VECTORS = [('splitlines', splitlines), ('tail', tail), ('strptime', strptime), ('pydumps', pydumps), ('slug', slug),
           ('merge_provenance', merge_provenance), ('audit_entry', audit_entry), ('json_atomic', json_atomic),
           ('external_state', external_state), ('classify_state', classify_state), ('classify_rules', classify_rules),
           ('events_of', events_of), ('clip', clip)]


def build_all(L, ctx):
    """{file name: rows}. ctx: {'tmp': scratch dir, 'rules': panel_scenarios.rules_tree(...) result}."""
    return {name: fn(L, ctx) for name, fn in VECTORS}

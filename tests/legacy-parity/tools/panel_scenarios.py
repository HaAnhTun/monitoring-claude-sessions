"""Generator-owned scenario trees for the golden capture (design 06 section 5.2.4): the session-rule matrix (`rules`),
the side-panel files (`panels`) and the Claude session registry (`registry`). All content is made up.

Every builder takes the legacy module namespace `L` (see `determinism.load_legacy`), writes below a directory it is given
and returns what the capture needs to serve and describe the tree. Files are written as bytes with explicit newlines, so
the result does not depend on the platform's text mode; mtimes are set with `determinism.set_age`.
"""
import datetime
import json
import os
import time

import determinism as D

# ---- transcript line DSL (rules matrix) --------------------------------------------------------------------------------------
# A transcript is a list of {"json": record} or {"raw": text}, each with an optional "repeat". The file is the lines joined with
# LF plus a final LF; a "json" line is `json.dumps(record)` with Python's defaults.


def U(text):
    return {'json': {'type': 'user', 'message': {'role': 'user', 'content': text}}}


def UB(*blocks):
    return {'json': {'type': 'user', 'message': {'role': 'user', 'content': list(blocks)}}}


def A(text):
    return {'json': {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}}


def RAW(text, repeat=1):
    return {'raw': text, 'repeat': repeat}


def FILL(n):
    return {'json': {'type': 'summary', 'summary': 'filler'}, 'repeat': n}


def render_lines(lines):
    out = []
    for item in lines:
        text = json.dumps(item['json']) if 'json' in item else item['raw']
        out.extend([text] * item.get('repeat', 1))
    return ('\n'.join(out) + '\n').encode('utf-8')


def _rule(match, label=None, **extra):
    r = {'match': match}
    if label is not None:
        r['label'] = label
    r.update(extra)
    return r


_STEP = _rule('STEP=([A-Z]):', 'step {1}')
_START = '^(?P<time>\\S+ \\S+) STEP (?P<part>[A-Z]) START'
_END_NO_STATUS = '^(?P<time>\\S+ \\S+) STEP (?P<part>[A-Z]) END exit=(?P<exit>[0-9]+)'

# Session-classification cases (matrix 5.7). id, title, rules, transcript lines.
RULE_CASES = [
    ('R01', 'numbered group in the label', [_STEP], [U('Run STEP=B: build the thing')]),
    ('R02', 'named group, label uses its number', [_rule('STEP=(?P<s>[A-Z])', '{1}')], [U('Run STEP=C now')]),
    ('R03', '{0} is cut at 40 code points (emoji inside)', [_rule('START.*END', '{0}')],
     [U('START ' + '\U0001F642' * 30 + 'abcdefghij' * 3 + 'END')]),
    ('R04', 'unmatched alternative group becomes empty text', [_rule('(a)|(b)', '{1}-{2}')], [U('b')]),
    ('R05', 'sequential replacement artefact', [_rule('^(\\S+) (\\S+)', '{1}{2}')], [U('{2} zzz')]),
    ('R06', 'dot matches newline (DOTALL)', [_rule('start.*end', 'span')], [U('start\nmiddle end')]),
    ('R07', '^ anchors at the start of the text only', [_rule('^STEP', 'anchored')], [U('first line\nSTEP=1')]),
    ('R08', '$ matches before a trailing newline', [_rule('done$', 'tail')], [U('done\n')]),
    ('R09', '\\A and \\Z anchors', [_rule('\\Afoo.*bar\\Z', 'both')], [U('foo bar')]),
    ('R10', '\\w matches a non-ASCII letter', [_rule('\\w+', '{0}')], [U('\N{LATIN SMALL LETTER E WITH ACUTE}')]),
    ('R11', '\\d matches an Arabic-Indic digit', [_rule('\\d', 'digit')], [U('x\N{ARABIC-INDIC DIGIT THREE}')]),
    ('R12', 'leading (?i) flag', [_rule('(?i)step', 'ci')], [U('STEP=1')]),
    ('R13', 'verbose flag (?x)', [_rule('(?x) STEP = ([A-Z])', '{1}')], [U('STEP=B')]),
    ('R14', 'lookbehind', [_rule('(?<=STEP=)[A-Z]', '{0}')], [U('STEP=Q')]),
    ('R15', 'possessive quantifier', [_rule('a++', '{0}')], [U('caaat')]),
    ('R16', 'named backreference', [_rule('(?P<x>a)(?P=x)', '{0}')], [U('xaay')]),
    ('R17', 'scope any finds a match in the third prompt', [_rule('NEEDLE', 'found', scope='any')], [U('one'), U('two'), U('NEEDLE here')]),
    ('R18', 'scope any overshoots the limit of 25 texts', [_rule('NEEDLE', 'found', scope='any')],
     [U('p%d' % i) for i in range(1, 25)] + [UB({'type': 'text', 'text': 'b1'}, {'type': 'text', 'text': 'NEEDLE'}, {'type': 'text', 'text': 'b3'})]),
    ('R19', 'harness boilerplate is skipped', [_STEP],
     [U('<system-reminder>reminder</system-reminder>'), U('Run STEP=Q: the real prompt')]),
    ('R20', 'only boilerplate and no matching rule: the first text is the unmatched fallback label', [],
     [U('<system-reminder>reminder only</system-reminder>')]),
    ('R20-matched', 'only boilerplate: the first text is what a rule is matched against', [_rule('reminder', 'fallback')],
     [U('<system-reminder>reminder only</system-reminder>')]),
    ('R21', 'first matching rule wins', [_rule('STEP', 'first'), _rule('STEP=', 'second')], [U('STEP=1')]),
    ('R22', 'a rule without label uses its name', [{'match': 'STEP', 'name': 'named-rule'}], [U('STEP=1')]),
    ('R23', 'unmatched multi-line prompt is flattened and cut at 70', [],
     [U('  ' + 'line one\n' * 3 + 'second block \U0001F642 ' * 6 + 'x' * 40 + '\n')]),
    ('R24', 'no user text', [_STEP], [A('hello')]),
    ('R25', 'invalid pattern is skipped at runtime', [_rule('(', 'broken'), _rule('STEP', 'ok')], [U('STEP=1')]),
    ('R26', 'a tool_result block is not a text candidate', [_rule('STEP=Z', 'leak')],
     [UB({'type': 'tool_result', 'tool_use_id': 't1', 'content': 'STEP=Z'}), U('nothing')]),
    ('R27', 'prompt on line 402 is not seen', [_rule('STEP', 'late')], [FILL(401), U('STEP=1')]),
    ('R28', 'invalid JSON lines consume line numbers', [_rule('STEP', 'late')], [RAW('{not json', 401), U('STEP=1')]),
    ('R29', '[[:alpha:]] is a literal set', [_rule('[[:alpha:]]', '{0}')], [U('xa] test')]),
    ('R30', 'example session rule of chain.config.example.json', [_rule('run-build[.]md.*?STEP=([A-Z0-9]+)', 'build step {1}')],
     [U('Follow run-build.md and execute STEP=A2 now')]),
]

# Attempts-regex cases (5.7 R30 attempts part, R31-R33): panels.attempts_rows over crafted chain-log lines, no sessions.
_EX_ATTEMPTS = {
    'label_prefix': 'build step ', 'time_format': '%Y-%m-%d %H:%M:%S',
    'start': '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) STEP (?P<part>[A-Z0-9]+) START attempt (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)',
    'end': '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) STEP (?P<part>[A-Z0-9]+) END exit=(?P<exit>[0-9]+) status=(?P<status>[A-Z ]+)',
}
ATTEMPT_CASES = [
    ('R30-attempts', 'example attempts patterns on sample lines', _EX_ATTEMPTS,
     ['2026-09-21 13:00:00 STEP A1 START attempt 2 model sonnet effort high', '2026-09-21 13:10:00 STEP A1 END exit=0 status=PASS DONE',
      '2026-09-21 13:11:00 STEP B2 START attempt 1 model haiku effort low', '2026-09-21 13:12:30 STEP B2 END exit=2 status=FAIL']),
    ('R31', 'start pattern matches at position 0 only, trailing text is fine', {'start': _START, 'end': _END_NO_STATUS},
     ['2026-09-21 13:00:00 STEP A START trailing text after the pattern', 'noise 2026-09-21 13:05:00 STEP B START', '2026-09-21 13:10:00 STEP A END exit=0']),
    ('R32', 'end pattern without a status group', {'start': _START, 'end': _END_NO_STATUS},
     ['2026-09-21 13:00:00 STEP A START', '2026-09-21 13:10:00 STEP A END exit=0', '2026-09-21 13:11:00 STEP B START', '2026-09-21 13:12:00 STEP B END exit=3']),
    ('R33', 'leading (?i) in an attempts pattern', {'start': '(?i)' + _START.replace('STEP', 'step').replace('START', 'start'), 'end': _END_NO_STATUS},
     ['2026-09-21 13:00:00 STEP A START', '2026-09-21 13:10:00 STEP A END exit=0']),
]


def _write(path, data, age_s=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    if age_s is not None:
        D.set_age(path, age_s)


def rules_tree(root):
    """One project folder per matrix case under `<root>/home/projects/rules-<id>/`; session ids are drawn in case order.
    Returns [{case, title, rules, lines, sid, path, tdir}]."""
    D.reset_uuids()
    out = []
    home = os.path.join(root, 'home')
    for cid, title, rules, lines in RULE_CASES:
        import uuid
        sid = str(uuid.uuid4())
        tdir = os.path.join(home, 'projects', 'rules-' + cid)
        path = os.path.join(tdir, sid + '.jsonl')
        _write(path, render_lines(lines), 600)
        out.append({'case': cid, 'title': title, 'rules': rules, 'lines': lines, 'sid': sid, 'path': path, 'tdir': tdir})
    return {'home': home, 'cases': out}


def rules_config(root, case):
    return {'title': 'rules ' + case['case'], 'repo': root, 'transcripts_dir': case['tdir'], 'session_rules': case['rules'], 'docker': False,
            'panels': {'machine': False, 'git': False}}


# ---- panels scenario ---------------------------------------------------------------------------------------------------------

def _cut_log():
    """About 70 KB whose last 65,536 bytes start inside a two-byte character: the panel's seek lands on a continuation byte."""
    e_acute = '\N{LATIN SMALL LETTER E WITH ACUTE}'
    line = (e_acute * 3000 + '\n').encode('utf-8')
    for extra in range(4):  # ASCII bytes appended to the last line move the cut relative to the character boundaries
        data = b'cut-log header\n' + line * 11 + (e_acute * 3000).encode('utf-8') + b'x' * extra + b'\n'
        cut = len(data) - 65536
        if cut > 0 and 0x80 <= data[cut] <= 0xBF and data[cut - 1] >= 0xC0:
            return data
    raise RuntimeError('cannot build the cut.log fixture')


def _big_log():
    return b''.join(b'%05d ' % i + b'x' * 50 + b'\n' for i in range(1250))


LOG_FILES = [  # name, bytes, age in seconds (distinct, so the panel's newest-first order never depends on a tie)
    ('crlf.log', b''.join(b'crlf line %d\r\n' % i for i in range(1, 21)), 10),
    ('cr.log', b''.join(b'cr line %d\r' % i for i in range(1, 21)), 20),
    ('nel.log', b''.join(b'nel first %d\xc2\x85nel second %d\n' % (i, i) for i in range(1, 11)), 30),
    ('ls.log', b''.join(('ls first %d\N{LINE SEPARATOR}ls second %d\N{PARAGRAPH SEPARATOR}ls third %d\n' % (i, i, i)).encode('utf-8') for i in range(1, 11)), 40),
    ('cut.log', None, 50),
    ('big.log', None, 60),
]

LEDGER = (b'# Status ledger\n| Step | Status | Notes |\n|---|---|---|\n| A | PASS | compile and unit tests |\n\n'
          b'free text between the rows\r\n| B | FAIL | blocked by a missing stub |\r\n| C | RUNNING | r\xc3\xa9sum\xc3\xa9 and caf\xc3\xa9 |\n'
          b'| D | NOTE | split\xe2\x80\xa8here |\n  | E | indented | not a table row |\n| F | DONE | last row |   \n')

_PART_START = {'A': 3000, 'B': 2600, 'C': 220}  # seconds before the frozen now at which the session starts


def _local(epoch):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(epoch))


def panels_attempts_config():
    return {'label_prefix': 'build step ', 'time_format': '%Y-%m-%d %H:%M:%S',
            'start': '^(?P<time>\\S+ \\S+) STEP (?P<part>[A-Z]) START attempt (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)',
            'end': '^(?P<time>\\S+ \\S+) STEP (?P<part>[A-Z]) END exit=(?P<exit>[0-9]+)(?: status=(?P<status>[A-Z]+))?'}


def panels_tree(root, L):
    """Logs, ledger, chain log and a STOP file under `<root>/repo`, three matching sessions under `<root>/home/projects/demo`.
    The chain-log times are formatted in the local zone from epochs relative to the frozen now, so the rows and the session
    matches are the same instants in every zone (only the text differs)."""
    import uuid
    D.reset_uuids()
    M = L.make
    repo, home = os.path.join(root, 'repo'), os.path.join(root, 'home')
    tdir = os.path.join(home, 'projects', 'demo')
    ids = {k: str(uuid.uuid4()) for k in 'ABC'}
    base = lambda ago: D.FrozenDT.fromtimestamp(D.FROZEN_NOW - ago, datetime.timezone.utc)  # noqa: E731
    for part, ago in _PART_START.items():
        recs = [M.user('Run STEP=%s: panels scenario' % part, M.iso(0, base(ago))),
                M.assistant([M.text('Done with part %s.' % part)], 'msg_p%s' % part, M.iso(5, base(ago)), stop='end_turn')]
        M.write_jsonl(os.path.join(tdir, ids[part] + '.jsonl'), recs)
        D.set_age(os.path.join(tdir, ids[part] + '.jsonl'), ago - 10)
    for name, data, age_s in LOG_FILES:
        data = _cut_log() if name == 'cut.log' else _big_log() if name == 'big.log' else data
        _write(os.path.join(repo, 'logs', name), data, age_s)
    _write(os.path.join(repo, 'docs', 'status.md'), LEDGER, 5)
    f = D.FROZEN_NOW
    chain = [
        '%s STEP A START attempt 1 model sonnet effort medium' % _local(f - 3001),
        'a line that is not part of the protocol',
        '%s STEP A END exit=0 status=PASS' % _local(f - 2400),
        '',
        '%s STEP B START attempt 1 model sonnet effort medium' % _local(f - 2601),
        '%s STEP B START attempt 2 model sonnet effort high' % _local(f - 2600),
        '%s STEP B END exit=1 status=FAIL' % _local(f - 1900),
        '%s STEP C START attempt 1 model haiku effort low' % _local(f - 221),
        '9999-99-99 99:99:99 STEP C END exit=0 status=PASS',
        '9999-99-99 99:99:99 STEP E START attempt 1 model x effort y',
        '%s STEP E END exit=0 status=PASS' % _local(f - 150),
        '%s STEP D START attempt 1 model opus effort high' % _local(f - 100),
        '%s STEP D END exit=0' % _local(f - 50),
        '%s STEP Z END exit=0 status=PASS' % _local(f - 40),
        '%s STEP F START attempt 1 model opus effort high' % _local(f - 30),
    ]
    _write(os.path.join(repo, 'chain', 'chain.log'), ('\r\n'.join(chain) + '\r\n').encode('utf-8'), 5)
    _write(os.path.join(repo, 'STOP'), b'stop\n', 5)
    cfg = {'title': 'panels', 'repo': repo, 'transcripts_dir': tdir, 'session_rules': [_rule('STEP=([A-Z]):', 'build step {1}')],
           'panels': {'machine': False, 'git': False, 'logs': True, 'ledger': True, 'chain_log': True, 'attempts': True},
           'live_log_globs': ['logs/*.log'], 'chain_log': 'chain/chain.log', 'ledger': 'docs/status.md', 'stop_file': 'STOP',
           'attempts': panels_attempts_config(), 'docker': False}
    return {'root': root, 'home': home, 'repo': repo, 'tdir': tdir, 'ids': ids, 'cfg': cfg, 'log_names': [n for n, _, _ in LOG_FILES]}


# ---- registry scenario -------------------------------------------------------------------------------------------------------

DEAD_PID = 999999


def registry_tree(root, L):
    """The fixture tree plus `<home>/sessions/*.json`: busy (alive), idle (alive, kind bg), waiting (alive), busy (dead pid),
    and a `<pid>.key` decoy that must never be opened. `alive` is this process's pid."""
    D.reset_uuids()
    fx = L.make.build_home(os.path.join(root, 'home'))
    ids, alive = fx['ids'], os.getpid()
    entries = [
        ('alive-busy.json', {'sessionId': ids['running'], 'pid': alive, 'status': 'busy', 'kind': 'cli'}),
        ('alive-idle.json', {'sessionId': ids['done'], 'pid': alive, 'status': 'idle', 'kind': 'bg'}),
        ('alive-waiting.json', {'sessionId': ids['failing'], 'pid': alive, 'status': 'waiting', 'waitingFor': 'permission prompt', 'kind': 'cli'}),
        ('dead-busy.json', {'sessionId': ids['pending'], 'pid': DEAD_PID, 'status': 'busy', 'kind': 'cli'}),
    ]
    for name, entry in entries:
        _write(os.path.join(fx['home'], 'sessions', name), json.dumps(entry).encode('utf-8'))
    _write(os.path.join(fx['home'], 'sessions', '4242.key'), b'decoy: never opened, never parsed\n')
    D.freeze_untouched(fx['home'])
    return {'home': fx['home'], 'tdir': fx['tdir'], 'ids': ids, 'entries': [n for n, _ in entries]}

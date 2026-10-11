// DA-T-S-7 (units): `countEntries` equals `displayEntries(...).length`, and the projection equals the legacy `events_of` of
// `src/backend/reader.py`. The vectors below were produced by running that Python function over synthetic records (the generator
// lives in the lead's scratch folder, not in the repository); every record and every expected entry is synthetic.
import { describe, expect, it } from 'vitest';

import {
  notificationSession,
  ordinarySession,
  parsedRecords,
  sentinelSession,
} from '../../test/fixtures/transcripts.ts';
import { clipText, countEntries, displayEntries, recordTimestamp, type DisplayEntry } from './entries.ts';

interface Vector {
  readonly name: string;
  readonly textChars: number;
  readonly record: unknown;
  readonly expected: readonly Record<string, unknown>[];
}

const VECTORS: readonly Vector[] = [
  {
    name: 'user string prompt',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        role: 'user',
        content: 'FIXTURE hello',
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: 'FIXTURE hello',
      },
    ],
  },
  {
    name: 'user empty string',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: '',
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: '',
      },
    ],
  },
  {
    name: 'user no timestamp',
    textChars: 6000,
    record: {
      type: 'user',
      message: {
        content: 'FIXTURE x',
      },
    },
    expected: [
      {
        t: '',
        k: 'prompt',
        text: 'FIXTURE x',
      },
    ],
  },
  {
    name: 'user text block and tool result',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'text',
            text: 'FIXTURE a',
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'FIXTURE out',
          },
          {
            type: 'image',
            source: {},
          },
          'not a block',
          {
            type: 'text',
          },
          {
            type: 'text',
            text: null,
          },
          {
            type: 'text',
            text: 12,
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: 'FIXTURE a',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'toolu_1',
        text: 'FIXTURE out',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: '',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: 'null',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: '12',
      },
    ],
  },
  {
    name: 'tool result list content',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: [
              {
                type: 'text',
                text: 'line one',
              },
              {
                type: 'image',
              },
              {
                type: 'text',
                text: 'line two',
              },
            ],
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'toolu_2',
        text: 'line one\n\nline two',
        err: true,
      },
    ],
  },
  {
    name: 'tool result falsy and odd contents',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: null,
          },
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: {},
          },
          {
            type: 'tool_result',
            tool_use_id: 'c',
            content: 5,
          },
          {
            type: 'tool_result',
            tool_use_id: 'd',
            content: {
              k: [1, 2.5, null, true],
            },
          },
          {
            type: 'tool_result',
            content: 'no id',
            is_error: 1,
          },
          {
            type: 'tool_result',
            tool_use_id: 'e',
            content: [],
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 7,
            content: 'numeric id',
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'a',
        text: '',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'b',
        text: '',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'c',
        text: '5',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'd',
        text: '{"k": [1, 2.5, null, true]}',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: null,
        text: 'no id',
        err: true,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 'e',
        text: '',
        err: false,
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'result',
        id: 7,
        text: 'numeric id',
        err: false,
      },
    ],
  },
  {
    name: 'long text clipped at 200',
    textChars: 200,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content:
          'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ',
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: 'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word  ... [truncated 7300 chars]',
      },
    ],
  },
  {
    name: 'astral text clipped on a code point',
    textChars: 31,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content:
          '\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00tail',
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'prompt',
        text: '\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00t ... [truncated 3 chars]',
      },
    ],
  },
  {
    name: 'assistant text blank and not',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'text',
            text: '   ',
          },
          {
            type: 'text',
            text: '\u00a0\u2003\u3000',
          },
          {
            type: 'text',
            text: '',
          },
          {
            type: 'text',
            text: '\ufeff',
          },
          {
            type: 'text',
            text: '\u001c',
          },
          {
            type: 'text',
            text: ' FIXTURE answer ',
          },
          {
            type: 'text',
            text: 5,
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'say',
        text: '\ufeff',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'say',
        text: ' FIXTURE answer ',
      },
    ],
  },
  {
    name: 'assistant tool use summary keys',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'Bash',
            input: {
              command: 'echo one\necho two',
              description: 'd',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_10',
            name: 'Read',
            input: {
              file_path: 'FIXTURE/a.txt',
              limit: 10,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_11',
            name: 'Grep',
            input: {
              pattern: 'x',
              path: 'y',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_12',
            name: 'Task',
            input: {
              description: '',
              prompt: 'FIXTURE p',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_13',
            name: 'Script',
            input: {
              script: 'a\nb',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_14',
            name: 'Other',
            input: {
              x: 1,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_15',
            name: 'Num',
            input: {
              command: 42,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_16',
            name: 'Lst',
            input: {
              command: [
                'a',
                1,
                null,
                {
                  b: true,
                },
              ],
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_17',
            name: 'Flt',
            input: {
              command: 2.5,
              n: 0.1,
            },
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_9',
        name: 'Bash',
        summary: 'echo one',
        input: '{"command": "echo one\\necho two", "description": "d"}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_10',
        name: 'Read',
        summary: 'FIXTURE/a.txt',
        input: '{"file_path": "FIXTURE/a.txt", "limit": 10}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_11',
        name: 'Grep',
        summary: 'x',
        input: '{"pattern": "x", "path": "y"}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_12',
        name: 'Task',
        summary: 'FIXTURE p',
        input: '{"description": "", "prompt": "FIXTURE p"}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_13',
        name: 'Script',
        summary: 'a',
        input: '{"script": "a\\nb"}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_14',
        name: 'Other',
        summary: '',
        input: '{"x": 1}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_15',
        name: 'Num',
        summary: '42',
        input: '{"command": 42}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_16',
        name: 'Lst',
        summary: "['a', 1, None, {'b': True}]",
        input: '{"command": ["a", 1, null, {"b": true}]}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_17',
        name: 'Flt',
        summary: '2.5',
        input: '{"command": 2.5, "n": 0.1}',
      },
    ],
  },
  {
    name: 'assistant tool use odd shapes',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_20',
            input: 'not a dict',
          },
          {
            type: 'tool_use',
            name: '',
            input: null,
          },
          {
            type: 'tool_use',
            id: 5,
            name: 'Bash',
          },
          {
            type: 'tool_use',
            id: 'toolu_21',
            name: 'Uni',
            input: {
              command: 'caf\u00e9 \u4e2d\u6587 \ud83d\ude00',
              q: 'a"b\\c',
            },
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_20',
        name: '?',
        summary: '',
        input: '{}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: null,
        name: '?',
        summary: '',
        input: '{}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 5,
        name: 'Bash',
        summary: '',
        input: '{}',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_21',
        name: 'Uni',
        summary: 'caf\u00e9 \u4e2d\u6587 \ud83d\ude00',
        input: '{"command": "caf\u00e9 \u4e2d\u6587 \ud83d\ude00", "q": "a\\"b\\\\c"}',
      },
    ],
  },
  {
    name: 'assistant tool input clipped',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_30',
            name: 'Big',
            input: {
              command:
                'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ',
            },
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_30',
        name: 'Big',
        summary:
          'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word  ... [truncated 22340 chars]',
        input:
          '{"command": "word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word wo ... [truncated 18515 chars]',
      },
    ],
  },
  {
    name: 'assistant thinking',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'FIXTURE thought',
            signature: 'SIG',
          },
          {
            type: 'thinking',
            thinking: '',
          },
          {
            type: 'thinking',
          },
          {
            type: 'thinking',
            thinking:
              'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word ',
          },
          {
            type: 'thinking',
            thinking: [1, 2],
          },
          {
            type: 'redacted_thinking',
            data: 'x',
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'think',
        text: 'FIXTURE thought',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'think',
        text: 'word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word  ... [truncated 6000 chars]',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'think',
        text: '[1, 2]',
      },
    ],
  },
  {
    name: 'assistant content is a string',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: 'FIXTURE',
      },
    },
    expected: [],
  },
  {
    name: 'assistant without message',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
    },
    expected: [],
  },
  {
    name: 'message is not an object',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: 'FIXTURE',
    },
    expected: [],
  },
  {
    name: 'system record',
    textChars: 6000,
    record: {
      type: 'system',
      timestamp: '2026-10-11T14:05:07.123Z',
      subtype: 'x',
      content: 'FIXTURE',
    },
    expected: [],
  },
  {
    name: 'attachment record',
    textChars: 6000,
    record: {
      type: 'attachment',
      timestamp: '2026-10-11T14:05:07.123Z',
      attachment: {
        type: 'x',
      },
    },
    expected: [],
  },
  {
    name: 'timestamp not a string',
    textChars: 6000,
    record: {
      type: 'user',
      timestamp: null,
      message: {
        content: 'FIXTURE',
      },
    },
    expected: [
      {
        t: '',
        k: 'prompt',
        text: 'FIXTURE',
      },
    ],
  },
  {
    name: 'mixed assistant record',
    textChars: 6000,
    record: {
      type: 'assistant',
      timestamp: '2026-10-11T14:05:07.123Z',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'FIXTURE t',
          },
          {
            type: 'text',
            text: 'FIXTURE say',
          },
          {
            type: 'tool_use',
            id: 'toolu_40',
            name: 'Bash',
            input: {
              command: 'ls',
            },
          },
        ],
      },
    },
    expected: [
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'think',
        text: 'FIXTURE t',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'say',
        text: 'FIXTURE say',
      },
      {
        t: '2026-10-11T14:05:07.123Z',
        k: 'tool',
        id: 'toolu_40',
        name: 'Bash',
        summary: 'ls',
        input: '{"command": "ls"}',
      },
    ],
  },
];

/**
 * The legacy entry as the typed contract carries it: a null field is absent, and an `id` or a `name` that is not a text (a
 * shape the contract does not admit) is absent or `'?'`.
 */
function asContract(entry: Record<string, unknown>): DisplayEntry {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null) continue;
    if (key === 'id' && typeof value !== 'string') continue;
    out[key] = value;
  }
  return out as unknown as DisplayEntry;
}

describe('displayEntries against the legacy events_of', () => {
  it('has vectors', () => {
    expect(VECTORS.length).toBeGreaterThan(15);
  });

  for (const vector of VECTORS) {
    it(`matches: ${vector.name}`, () => {
      expect(displayEntries(vector.record, { textChars: vector.textChars })).toEqual(vector.expected.map(asContract));
    });

    it(`counts: ${vector.name}`, () => {
      expect(countEntries(vector.record)).toBe(vector.expected.length);
    });
  }
});

describe('countEntries', () => {
  it('equals the length of displayEntries on the records of the fixture sessions', () => {
    const records = [ordinarySession(), notificationSession(), sentinelSession()].flatMap((b) => parsedRecords(b));
    expect(records.length).toBeGreaterThan(10);
    for (const record of records) {
      expect(countEntries(record)).toBe(displayEntries(record, { textChars: 6000 }).length);
    }
  });
});

describe('records that produce nothing', () => {
  it.each([null, undefined, 5, 'text', [], [{ type: 'user' }], {}, { type: 'system' }, { type: 'user', message: 7 }])(
    'projects %j to no entries',
    (record) => {
      expect(displayEntries(record, { textChars: 6000 })).toEqual([]);
      expect(countEntries(record)).toBe(0);
    },
  );
});

describe('clipText', () => {
  it('keeps a text of at most n code points', () => {
    expect(clipText('abcdef', 6)).toBe('abcdef');
    expect(clipText('', 3)).toBe('');
  });

  it('cuts on code points, never inside a surrogate pair, and counts the rest in code points', () => {
    const text = 'a\u{1F600}b\u{1F600}c';
    expect(clipText(text, 2)).toBe('a\u{1F600} ... [truncated 3 chars]');
    expect(clipText(text, 5)).toBe(text);
  });

  it('writes a value that is not a text as Python json.dumps does', () => {
    expect(clipText({ a: [1, 2.5, null, true], b: 'x' }, 100)).toBe('{"a": [1, 2.5, null, true], "b": "x"}');
    expect(clipText({}, 100)).toBe('{}');
  });
});

describe('recordTimestamp', () => {
  it('is the timestamp text or the empty text', () => {
    expect(recordTimestamp({ timestamp: '2026-10-11T14:05:07.123Z' })).toBe('2026-10-11T14:05:07.123Z');
    expect(recordTimestamp({ timestamp: 5 })).toBe('');
    expect(recordTimestamp({})).toBe('');
    expect(recordTimestamp(null)).toBe('');
  });
});

describe('tool result lists and numbers read back from a file (differential findings of the verifier)', () => {
  const T = '2026-10-11T14:05:07.123Z';
  const resultOf = (content: unknown): unknown =>
    displayEntries(
      { type: 'user', timestamp: T, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content }] } },
      { textChars: 6000 },
    )[0]?.text;

  // expected values produced by the legacy events_of (`'\n'.join(... for x in cc if isinstance(x, dict))`)
  it('leaves out the items of a result list that are not objects', () => {
    expect(resultOf(['a', 'b'])).toBe('');
    expect(resultOf([{ type: 'text', text: 'a' }, 'junk', { type: 'text', text: 'b' }])).toBe(
      `a${String.fromCharCode(10)}b`,
    );
  });

  const inputOf = (fileText: string): unknown =>
    displayEntries(
      {
        type: 'assistant',
        timestamp: T,
        message: { content: [{ type: 'tool_use', id: 't', name: 'X', input: JSON.parse(fileText) as unknown }] },
      },
      { textChars: 6000 },
    )[0];

  it('writes a huge integer-valued number as a float, as Python does for 1.5e300', () => {
    expect(inputOf('{"big": 1.5e300, "n": 1.5}')).toMatchObject({ input: '{"big": 1.5e+300, "n": 1.5}' });
  });

  it('writes an integer below 2**64 with its digits; digits beyond 2**53 stay rounded (recorded deviation)', () => {
    expect(inputOf('{"id": 9007199254740993}')).toMatchObject({ input: '{"id": 9007199254740992}' });
    expect(inputOf('{"id": 12345}')).toMatchObject({ input: '{"id": 12345}' });
  });
});

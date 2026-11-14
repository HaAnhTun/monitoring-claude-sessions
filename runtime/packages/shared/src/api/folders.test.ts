import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActivityMarkSchema,
  AddFolderBodySchema,
  FOLDER_GROUPS,
  FOLDER_ORIGINS,
  FOLDER_PATH_SOURCES,
  FolderListResponseSchema,
  FolderSchema,
  LINK_BASES,
  LINK_CONFIDENCES,
  LINK_REASONS,
  LINK_STATUSES,
  ResumeEligibilitySchema,
  TerminalLinkSchema,
} from './folders.ts';
import { ACTIVITY_MARKS } from '../folders/index.ts';

const AT = '2026-11-14T09:30:05.000Z';
const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';

/** A copy of `value` without one key (the tests need objects with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const folder = {
  key: 'd--work-app',
  name: 'app',
  path: 'D:\\work\\app',
  pathSource: 'da',
  exists: true,
  origins: ['da', 'claude'],
  group: 'da',
  activity: 'full',
  lastActivityAt: AT,
  da: { lastUpdatedAt: AT, activity: 'half', summary: 'Refactor of the importer', brain: 3, action: 12 },
  claude: { dirName: 'D--work-app', sessionsInWindow: 2, activeSessions: 1, totalSessions: 9, lastSessionAt: AT },
  canStart: true,
  userAdded: false,
};

const listResponse = {
  folders: [folder],
  sources: {
    daMemory: { status: 'ok', folders: 1, readAt: AT },
    claudeHome: { status: 'ok', folders: 1, scannedAt: AT, truncated: false },
    userFolders: { status: 'absent', count: 0 },
  },
  asOf: AT,
};

const link = {
  status: 'linked',
  sessionId: SID,
  previousSessionIds: [],
  basis: 'registry-pid',
  confidence: 'high',
  since: AT,
  claudePid: 4242,
  transcript: 'tracked',
  registryStatus: 'busy',
  waitingFor: null,
  reason: null,
  shared: false,
};

const eligibility = {
  sessionId: SID,
  allowed: true,
  forkAllowed: true,
  reason: null,
  folder: { key: 'd--work-app', path: 'D:\\work\\app' },
  liveElsewhere: false,
  liveTerminal: null,
  redirectTo: null,
};

describe('enums', () => {
  it('the activity mark enum is built from the helper constant', () => {
    expect(ActivityMarkSchema.options).toEqual([...ACTIVITY_MARKS]);
  });

  it('lists the documented values', () => {
    expect([...FOLDER_ORIGINS]).toEqual(['da', 'user', 'claude', 'fallback']);
    expect([...FOLDER_PATH_SOURCES]).toEqual(['da', 'user', 'project', 'transcript', 'reverse', 'none']);
    expect([...FOLDER_GROUPS]).toEqual(['outside-da', 'da']);
    expect([...LINK_STATUSES]).toEqual(['pending', 'linked', 'ambiguous']);
    expect([...LINK_BASES]).toEqual([
      'registry-pid',
      'registry-tree',
      'registry-cwd',
      'registry-order',
      'resume-id',
      'transcript-time',
    ]);
    expect([...LINK_CONFIDENCES]).toEqual(['high', 'medium', 'low']);
    expect([...LINK_REASONS]).toEqual(['no_registry', 'registry_unreadable', 'ambiguous']);
  });
});

describe('FolderSchema', () => {
  it('accepts a full row and a row without any source detail', () => {
    expect(FolderSchema.parse(folder)).toEqual(folder);
    const bare = {
      ...folder,
      key: '-home-x-p',
      path: null,
      pathSource: 'none',
      exists: null,
      origins: ['fallback'],
      group: 'outside-da',
      activity: 'none',
      lastActivityAt: null,
      da: null,
      claude: null,
      canStart: false,
    };
    expect(FolderSchema.parse(bare)).toEqual(bare);
  });

  it('refuses a missing field, an unknown field and an out-of-range value', () => {
    for (const key of Object.keys(folder)) {
      expect(FolderSchema.safeParse(without(folder, key)).success, `without ${key}`).toBe(false);
    }
    const bad: Record<string, unknown>[] = [
      { extra: 1 },
      { key: 'Upper' },
      { key: '' },
      { name: '' },
      { name: 'x'.repeat(256) },
      { path: 'x'.repeat(1025) },
      { pathSource: 'guess' },
      { origins: [] },
      { origins: ['web'] },
      { group: 'other' },
      { activity: 'some' },
      { lastActivityAt: 'yesterday' },
      { exists: 'yes' },
      { canStart: 1 },
      { da: { ...folder.da, extra: 1 } },
      { da: { ...folder.da, summary: 'x'.repeat(121) } },
      { da: { ...folder.da, brain: -1 } },
      { da: without(folder.da, 'action') },
      { claude: { ...folder.claude, totalSessions: 1.5 } },
      { claude: without(folder.claude, 'dirName') },
    ];
    for (const patch of bad)
      expect(FolderSchema.safeParse({ ...folder, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });

  it('counts the summary in code points, so 120 astral characters fit', () => {
    const summary = '\u{1f600}'.repeat(120);
    expect(FolderSchema.safeParse({ ...folder, da: { ...folder.da, summary } }).success).toBe(true);
    expect(FolderSchema.safeParse({ ...folder, da: { ...folder.da, summary: `${summary}x` } }).success).toBe(false);
  });
});

describe('FolderListResponseSchema', () => {
  it('accepts a response and every status of the sources', () => {
    expect(FolderListResponseSchema.parse(listResponse)).toEqual(listResponse);
    for (const status of ['ok', 'absent', 'unreadable']) {
      const sources = { ...listResponse.sources, daMemory: { ...listResponse.sources.daMemory, status } };
      expect(FolderListResponseSchema.safeParse({ ...listResponse, sources }).success, status).toBe(true);
    }
    for (const status of ['ok', 'absent', 'corrupt', 'newer_version']) {
      const sources = { ...listResponse.sources, userFolders: { status, count: 2 } };
      expect(FolderListResponseSchema.safeParse({ ...listResponse, sources }).success, status).toBe(true);
    }
  });

  it('refuses unknown statuses, missing parts and more than 500 folders', () => {
    const sources = (patch: object) => ({ ...listResponse.sources, ...patch });
    expect(
      FolderListResponseSchema.safeParse({
        ...listResponse,
        sources: sources({ userFolders: { status: 'unreadable', count: 0 } }),
      }).success,
    ).toBe(false);
    expect(
      FolderListResponseSchema.safeParse({
        ...listResponse,
        sources: sources({ claudeHome: { status: 'ok', folders: 1, scannedAt: AT } }),
      }).success,
    ).toBe(false);
    expect(FolderListResponseSchema.safeParse(without(listResponse, 'asOf')).success).toBe(false);
    expect(FolderListResponseSchema.safeParse({ ...listResponse, extra: 1 }).success).toBe(false);
    expect(
      FolderListResponseSchema.safeParse({ ...listResponse, folders: Array.from({ length: 500 }, () => folder) })
        .success,
    ).toBe(true);
    expect(
      FolderListResponseSchema.safeParse({ ...listResponse, folders: Array.from({ length: 501 }, () => folder) })
        .success,
    ).toBe(false);
  });
});

describe('AddFolderBodySchema', () => {
  it('takes one path of 1 to 1024 characters and leaves the path rules to the service (folder_invalid)', () => {
    expect(AddFolderBodySchema.parse({ path: 'D:\\x' })).toEqual({ path: 'D:\\x' });
    // not the schema's job: a relative or UNC path is a 400 folder_invalid with the issue, not validation_failed
    expect(AddFolderBodySchema.safeParse({ path: '\\\\host\\share' }).success).toBe(true);
    expect(AddFolderBodySchema.safeParse({ path: 'x'.repeat(1024) }).success).toBe(true);
    for (const body of [
      {},
      { path: '' },
      { path: 'x'.repeat(1025) },
      { path: 1 },
      { path: 'D:\\x', extra: 1 },
      null,
      [],
    ]) {
      expect(AddFolderBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('ResumeEligibilitySchema', () => {
  it('accepts an allowed session and every refusal reason', () => {
    expect(ResumeEligibilitySchema.parse(eligibility)).toEqual(eligibility);
    for (const reason of [
      'transcript_gone',
      'folder_missing',
      'folder_unknown',
      'live_in_terminal',
      'live_elsewhere',
    ]) {
      expect(ResumeEligibilitySchema.safeParse({ ...eligibility, allowed: false, reason }).success, reason).toBe(true);
    }
    const elsewhere = {
      ...eligibility,
      allowed: false,
      reason: 'live_elsewhere',
      liveElsewhere: true,
      redirectTo: '3b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d12',
    };
    expect(ResumeEligibilitySchema.parse(elsewhere)).toEqual(elsewhere);
    const inTerminal = {
      ...eligibility,
      allowed: false,
      forkAllowed: false,
      reason: 'live_in_terminal',
      liveTerminal: 'app-1',
    };
    expect(ResumeEligibilitySchema.parse(inTerminal)).toEqual(inTerminal);
    expect(
      ResumeEligibilitySchema.parse({ ...eligibility, allowed: false, forkAllowed: false, folder: null }).folder,
    ).toBeNull();
  });

  it('refuses a missing field, an unknown reason and a bad id', () => {
    for (const key of Object.keys(eligibility)) {
      expect(ResumeEligibilitySchema.safeParse(without(eligibility, key)).success, `without ${key}`).toBe(false);
    }
    const bad: Record<string, unknown>[] = [
      { extra: 1 },
      { reason: 'busy' },
      { sessionId: 'nope' },
      { redirectTo: 'nope' },
      { liveTerminal: '' },
      { liveTerminal: 'x'.repeat(65) },
      { folder: { key: 'Upper', path: 'D:\\x' } },
      { folder: { key: 'a', path: 'D:\\x', extra: 1 } },
      { folder: { key: 'a' } },
      { allowed: 'yes' },
    ];
    for (const patch of bad) {
      expect(ResumeEligibilitySchema.safeParse({ ...eligibility, ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
    }
  });
});

describe('TerminalLinkSchema', () => {
  it('accepts a linked, a pending and an ambiguous link', () => {
    expect(TerminalLinkSchema.parse(link)).toEqual(link);
    const pending = {
      ...link,
      status: 'pending',
      sessionId: null,
      basis: null,
      confidence: null,
      since: null,
      claudePid: null,
      transcript: 'none',
      registryStatus: null,
      reason: 'no_registry',
    };
    expect(TerminalLinkSchema.parse(pending)).toEqual(pending);
    const ambiguous = { ...pending, status: 'ambiguous', reason: 'ambiguous' };
    expect(TerminalLinkSchema.parse(ambiguous)).toEqual(ambiguous);
  });

  it('accepts every basis, confidence, registry status and reason', () => {
    for (const basis of LINK_BASES) expect(TerminalLinkSchema.safeParse({ ...link, basis }).success, basis).toBe(true);
    for (const confidence of LINK_CONFIDENCES) {
      expect(TerminalLinkSchema.safeParse({ ...link, confidence }).success, confidence).toBe(true);
    }
    for (const registryStatus of ['busy', 'idle', 'waiting']) {
      expect(TerminalLinkSchema.safeParse({ ...link, registryStatus }).success, registryStatus).toBe(true);
    }
    for (const reason of LINK_REASONS)
      expect(TerminalLinkSchema.safeParse({ ...link, reason }).success, reason).toBe(true);
  });

  it('bounds the previous session ids to 8 and the waiting text to 64 characters', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `${i}`.padStart(8, '0') + SID.slice(8));
    expect(TerminalLinkSchema.safeParse({ ...link, previousSessionIds: ids(8) }).success).toBe(true);
    expect(TerminalLinkSchema.safeParse({ ...link, previousSessionIds: ids(9) }).success).toBe(false);
    expect(TerminalLinkSchema.safeParse({ ...link, waitingFor: 'x'.repeat(64) }).success).toBe(true);
    expect(TerminalLinkSchema.safeParse({ ...link, waitingFor: 'x'.repeat(65) }).success).toBe(false);
  });

  it('refuses a missing field, an unknown value and a pid that is not positive', () => {
    for (const key of Object.keys(link)) {
      expect(TerminalLinkSchema.safeParse(without(link, key)).success, `without ${key}`).toBe(false);
    }
    const bad: Record<string, unknown>[] = [
      { extra: 1 },
      { status: 'unlinked' },
      { basis: 'guess' },
      { confidence: 'certain' },
      { transcript: 'partial' },
      { registryStatus: 'running' },
      { reason: 'because' },
      { claudePid: 0 },
      { claudePid: -1 },
      { claudePid: 1.5 },
      { sessionId: 'nope' },
      { since: 'now' },
      { shared: 'no' },
    ];
    for (const patch of bad) {
      expect(TerminalLinkSchema.safeParse({ ...link, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe('generated JSON Schemas', () => {
  it('every schema converts to JSON Schema (no transform, no unrepresentable type)', () => {
    for (const schema of [
      FolderSchema,
      FolderListResponseSchema,
      AddFolderBodySchema,
      ResumeEligibilitySchema,
      TerminalLinkSchema,
    ]) {
      expect(() => z.toJSONSchema(schema, { io: 'output' })).not.toThrow();
      expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
    }
  });

  it('the strict objects stay closed', () => {
    const json = z.toJSONSchema(FolderSchema, { io: 'output' });
    expect(json).toMatchObject({ type: 'object', additionalProperties: false });
    expect(json.properties?.['key']).toMatchObject({ type: 'string', pattern: '^[a-z0-9-]{1,255}$' });
  });
});

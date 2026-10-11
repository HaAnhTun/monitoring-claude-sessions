import { describe, expect, it } from 'vitest';

import { makeAgent, makeSession, makeWorkItem, sessionId } from '../test/fixtures/index.ts';
import { createPatchLedger, ledgerKey } from './patch-ledger.ts';

describe('ledgerKey', () => {
  it('uses the entity key formats of 04 5.5 R4', () => {
    expect(ledgerKey.session('s1')).toBe('session:s1');
    expect(ledgerKey.agent('s1', 'a1')).toBe('agent:s1:a1');
    expect(ledgerKey.workflow('wf_1')).toBe('workflow:wf_1');
    expect(ledgerKey.workItem(7)).toBe('work_item:7');
    expect(ledgerKey.alert(9)).toBe('alert:9');
  });
});

describe('PatchLedger put/get (R1)', () => {
  it('keeps only the newest patch per entity and reports whether it stored one', () => {
    const ledger = createPatchLedger();
    expect(ledger.put('session', makeSession({ seq: 5 }))).toBe(true);
    expect(ledger.put('session', makeSession({ seq: 5, label: 'same seq' }))).toBe(false);
    expect(ledger.put('session', makeSession({ seq: 4, label: 'older' }))).toBe(false);
    expect(ledger.get('session', ledgerKey.session(sessionId(1)))?.seq).toBe(5);
    expect(ledger.get('session', ledgerKey.session(sessionId(1)))?.data.label).toBe('FIXTURE build step A');
    expect(ledger.put('session', makeSession({ seq: 6, label: 'newer' }))).toBe(true);
    expect(ledger.get('session', ledgerKey.session(sessionId(1)))?.data.label).toBe('newer');
    expect(ledger.size).toBe(1);
  });

  it('keeps agents of different sessions apart', () => {
    const ledger = createPatchLedger();
    ledger.put('agent', makeAgent({ sessionId: sessionId(1), seq: 3 }));
    ledger.put('agent', makeAgent({ sessionId: sessionId(2), seq: 4 }));
    expect(ledger.size).toBe(2);
  });

  it('remove() forgets one entity', () => {
    const ledger = createPatchLedger();
    ledger.put('session', makeSession({ seq: 5 }));
    ledger.put('session', makeSession({ id: sessionId(2), seq: 5 }));
    ledger.remove('session', ledgerKey.session(sessionId(1)));
    expect(ledger.size).toBe(1);
    expect(ledger.get('session', ledgerKey.session(sessionId(1)))).toBeUndefined();
    expect(ledger.put('session', makeSession({ seq: 1 }))).toBe(true);
  });

  it('clear() empties it', () => {
    const ledger = createPatchLedger();
    ledger.put('work_item', makeWorkItem({ seq: 2 }));
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.get('work_item', ledgerKey.workItem(1))).toBeUndefined();
  });
});

describe('PatchLedger reapply (R4)', () => {
  it('replaces a snapshot entity that is older than the ledger copy and keeps newer ones', () => {
    const ledger = createPatchLedger();
    ledger.put('session', makeSession({ id: sessionId(1), seq: 9, label: 'patched' }));
    const snapshot = [
      makeSession({ id: sessionId(1), seq: 7, label: 'stale' }),
      makeSession({ id: sessionId(2), seq: 3, label: 'untouched' }),
    ];
    const out = ledger.reapplyList('session', snapshot, 8);
    expect(out.map((s) => s.label)).toEqual(['patched', 'untouched']);
    expect(snapshot[0]?.label).toBe('stale');
  });

  it('does not replace an entity that is as new or newer, and returns the same array when nothing changed', () => {
    const ledger = createPatchLedger();
    ledger.put('session', makeSession({ id: sessionId(1), seq: 9 }));
    const snapshot = [
      makeSession({ id: sessionId(1), seq: 9, label: 'same' }),
      makeSession({ id: sessionId(2), seq: 12 }),
    ];
    expect(ledger.reapplyList('session', snapshot, 5)).toBe(snapshot);
    const newer = [makeSession({ id: sessionId(1), seq: 11, label: 'newer' })];
    expect(ledger.reapplyList('session', newer, 5)[0]?.label).toBe('newer');
  });

  it('evicts entries the snapshot already includes (seq <= asOfSeq) and keeps the later ones', () => {
    const ledger = createPatchLedger();
    ledger.put('session', makeSession({ id: sessionId(1), seq: 4 }));
    ledger.put('session', makeSession({ id: sessionId(2), seq: 9 }));
    ledger.reapplyList('session', [], 6);
    expect(ledger.get('session', ledgerKey.session(sessionId(1)))).toBeUndefined();
    expect(ledger.get('session', ledgerKey.session(sessionId(2)))?.seq).toBe(9);
  });

  it('reapplies one entity (the detail query)', () => {
    const ledger = createPatchLedger();
    ledger.put('work_item', makeWorkItem({ seq: 9, title: 'patched' }));
    expect(ledger.reapplyEntity('work_item', makeWorkItem({ seq: 3, title: 'old' }), 5).title).toBe('patched');
    expect(ledger.reapplyEntity('work_item', makeWorkItem({ seq: 20, title: 'new' }), 5).title).toBe('new');
  });
});

describe('PatchLedger LRU', () => {
  it('holds at most maxKeys entities and drops the least recently used', () => {
    const ledger = createPatchLedger(3);
    ledger.put('work_item', makeWorkItem({ id: 1, seq: 1 }));
    ledger.put('work_item', makeWorkItem({ id: 2, seq: 1 }));
    ledger.put('work_item', makeWorkItem({ id: 3, seq: 1 }));
    expect(ledger.get('work_item', ledgerKey.workItem(1))).toBeDefined(); // touch 1: 2 is now the oldest
    ledger.put('work_item', makeWorkItem({ id: 4, seq: 1 }));
    expect(ledger.size).toBe(3);
    expect(ledger.get('work_item', ledgerKey.workItem(2))).toBeUndefined();
    expect(ledger.get('work_item', ledgerKey.workItem(1))).toBeDefined();
    expect(ledger.get('work_item', ledgerKey.workItem(4))).toBeDefined();
  });

  it('defaults to 2000 keys', () => {
    const ledger = createPatchLedger();
    for (let i = 1; i <= 2005; i += 1) ledger.put('work_item', makeWorkItem({ id: i, seq: 1 }));
    expect(ledger.size).toBe(2000);
    expect(ledger.get('work_item', ledgerKey.workItem(1))).toBeUndefined();
    expect(ledger.get('work_item', ledgerKey.workItem(2005))).toBeDefined();
  });
});

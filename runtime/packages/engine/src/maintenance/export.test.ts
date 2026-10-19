// The pieces of the export that need no database (03 11.1): the sink that collects lines, hashes every byte and honours the back
// pressure of the output, and the strict redaction of one line. The export itself is proven over real databases in
// `test/maintenance-export.int.test.ts`.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import { ExportLineSchema, type ExportLine } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { createLineSink, projectPseudonym, redactLine } from './export.ts';

const live = (): AbortSignal => new AbortController().signal;

/** Lets the event loop turn a number of times: whatever would happen without a `drain` would have happened by then. */
async function turns(count = 25): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const header: ExportLine = {
  type: 'header',
  format: 'mcs.export/1',
  instanceId: '11111111-1111-4111-8111-111111111111',
  slug: 'demo',
  exportedAt: '2026-10-20T12:00:00.000Z',
  runtimeVersion: '4.0.0',
  dbSchemaVersion: 1,
  scope: { from: null, to: '2026-10-20T12:00:00.000Z', sessions: [] },
  include: ['sessions'],
  redaction: 'standard',
  includeContent: false,
  privacyNote: 'Metadata only: no prompt, reply, thinking or tool result text.',
};

const trailer = (sha256: string): ExportLine => ({ type: 'trailer', counts: {}, missingTranscripts: [], sha256 });

/** A writable that keeps what it is given and completes each write later, so that its buffer can fill. */
function collecting(highWaterMark: number): { out: Writable; text(): string; writes: number[] } {
  const chunks: Buffer[] = [];
  const writes: number[] = [];
  const out = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      writes.push(chunk.length);
      setImmediate(done);
    },
  });
  return { out, text: () => Buffer.concat(chunks).toString('utf8'), writes };
}

describe('createLineSink', () => {
  it('writes one JSON object and LF per line, counts lines and bytes, and hashes every byte', async () => {
    const sink = collecting(1 << 20);
    const lines = createLineSink(sink.out, live());
    await lines.line(header);
    await lines.line(trailer('0'.repeat(64)));
    await lines.finish();
    await new Promise<void>((resolve) => {
      sink.out.end(resolve);
    });

    const text = sink.text();
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(lines.lines).toBe(2);
    expect(lines.bytes).toBe(Buffer.byteLength(text));
    expect(ExportLineSchema.parse(JSON.parse(text.split('\n')[0] ?? ''))).toEqual(header);
    expect(lines.digest()).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('keeps a digest taken before the last line, and counts the bytes of non-ASCII text as UTF-8', async () => {
    const sink = collecting(1 << 20);
    const lines = createLineSink(sink.out, live());
    // two bytes for the e with an accent, three for each of the two Han characters
    const wide = ['caf', String.fromCharCode(0xe9), '-', String.fromCharCode(0x4e2d, 0x6587)].join('');
    await lines.line({ ...header, slug: wide });
    const first = lines.digest();
    await lines.line(trailer(first));
    expect(lines.digest()).not.toBe(first);
    await lines.finish();
    const text = sink.text();
    const firstLine = text.slice(0, text.indexOf('\n') + 1);
    expect(first).toBe(createHash('sha256').update(firstLine).digest('hex'));
    expect(lines.bytes).toBe(Buffer.byteLength(text));
    expect(Buffer.byteLength(firstLine)).toBeGreaterThan(firstLine.length);
  });

  it('collects lines into chunks and writes a chunk when it reaches its size', async () => {
    const sink = collecting(1 << 20);
    const lines = createLineSink(sink.out, live(), 400);
    for (let i = 0; i < 30; i += 1) await lines.line({ ...header, slug: `s${String(i)}` });
    await lines.finish();
    await new Promise<void>((resolve) => {
      sink.out.end(resolve);
    });
    expect(sink.writes.length).toBeGreaterThan(3);
    // a chunk ends at the first line that crosses the size: never much more than the size plus one line
    const longest = Math.max(...sink.writes);
    expect(longest).toBeLessThan(400 + JSON.stringify(header).length + 20);
    expect(sink.writes.reduce((sum, size) => sum + size, 0)).toBe(lines.bytes);
  });

  it('waits for drain when write answers false, and does not write again before it', async () => {
    let writes = 0;
    let release: (() => void) | undefined;
    const out = new Writable({
      highWaterMark: 1,
      write(_chunk: Buffer, _encoding, done) {
        writes += 1;
        release = done;
      },
    });
    const lines = createLineSink(out, live(), 10);
    let filled = false;
    const pending = (async (): Promise<void> => {
      await lines.line(header); // over the chunk size: one write, the buffer is full
      filled = true;
    })();
    await turns();
    expect(writes).toBe(1);
    expect(filled).toBe(false);
    release?.();
    await pending;
    expect(filled).toBe(true);
  });

  it('ends the wait with the reason of an abort, and with an error when the output closes', async () => {
    const stuck = (): Writable =>
      new Writable({
        highWaterMark: 1,
        write() {
          /* never completes */
        },
      });
    const controller = new AbortController();
    const aborted = createLineSink(stuck(), controller.signal, 10);
    const waiting = aborted.line(header).then(
      () => null,
      (error: unknown) => error,
    );
    await turns();
    controller.abort();
    const reason = await waiting;
    expect(reason instanceof Error ? reason.name : '').toBe('AbortError');

    const closing = stuck();
    const closed = createLineSink(closing, live(), 10);
    const stopped = closed.line(header).then(
      () => null,
      (error: unknown) => error,
    );
    await turns();
    closing.destroy();
    expect(await stopped).toBeInstanceOf(Error);
  });

  it('keeps an error event of the output and throws it at the next write; release stops listening', async () => {
    const out = new Writable({
      write(_chunk: Buffer, _encoding, done) {
        done();
      },
    });
    const lines = createLineSink(out, live(), 10);
    expect(out.listenerCount('error')).toBe(1);
    // an `error` event with no listener would end the process: the sink listens and keeps the first one
    out.emit('error', new Error('FIXTURE disk full'));
    out.emit('error', new Error('FIXTURE second'));
    await expect(lines.line(header)).rejects.toThrow('FIXTURE disk full');
    lines.release();
    expect(out.listenerCount('error')).toBe(0);
  });

  it('refuses to write once the signal is aborted', async () => {
    const controller = new AbortController();
    const sink = collecting(1 << 20);
    const lines = createLineSink(sink.out, controller.signal, 10);
    controller.abort();
    await expect(lines.line(header)).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.writes).toEqual([]);
  });
});

describe('redactLine (strict redaction)', () => {
  const workflow = { runId: 'wf_x', name: 'FIXTURE name', phase: 'p', state: 'working' as const };
  const state = {
    state: 'unknown' as const,
    presence: 'unknown' as const,
    waitReason: null,
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'inferred' as const,
    confidence: 'low' as const,
    rule: 'none',
    evidence: [],
    since: null,
    evaluatedAt: null,
    legacyState: 'UNKNOWN' as const,
  };
  const usage = {
    input: null,
    output: null,
    cacheCreation: null,
    cacheRead: null,
    total: null,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 0,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete' as const,
    scannedPct: null,
    lowerBound: false,
  };

  it('pseudonymises a project id the same way every time, in the shape of a project id', () => {
    expect(projectPseudonym('fixture-project')).toBe(projectPseudonym('fixture-project'));
    expect(projectPseudonym('fixture-project')).not.toBe(projectPseudonym('other-project'));
    expect(projectPseudonym('fixture-project')).toMatch(/^p-[0-9a-f]{12}$/);
  });

  it('leaves the lines that hold no text of the person alone', () => {
    const transition: ExportLine = {
      type: 'transition',
      data: {
        sessionId: 'cccccccc-0000-4000-8000-000000000001',
        id: 1,
        at: '2026-10-20T12:00:00.000Z',
        agentId: null,
        from: null,
        to: 'running',
        rule: 'T-1',
        basis: 'observed',
        confidence: 'high',
        evidence: [],
      },
    };
    expect(redactLine(transition)).toBe(transition);
    expect(redactLine(header)).toBe(header);
    const gone: ExportLine = {
      type: 'transcript',
      sessionId: 'cccccccc-0000-4000-8000-000000000001',
      agentId: 'main',
      entries: [],
    };
    expect(redactLine(gone)).toBe(gone);
  });

  it('empties the label of a first-prompt session only, and drops the project name, directory and branch', () => {
    const base = {
      id: 'cccccccc-0000-4000-8000-000000000001',
      seq: 0,
      matched: true,
      pinned: false,
      projectId: 'fixture-project',
      projectLabel: 'Fixture project',
      workItemIds: [],
      provider: 'claude-code' as const,
      entrypoint: null,
      ccVersion: null,
      models: [],
      lastModel: null,
      startedAt: '2026-10-20T10:00:00.000Z',
      lastActivityAt: '2026-10-20T11:00:00.000Z',
      endedAt: null,
      durationMs: 0,
      state,
      agentCount: 0,
      activeAgentCount: 0,
      toolCallCount: 0,
      pendingTools: 0,
      errorCount: 0,
      warningCount: 0,
      usage,
      usageInclSubagents: usage,
      cost: null,
      reportedCost: null,
      partial: false,
      sources: { hooks: false, transcript: false },
      freshness: {
        lastHookAt: null,
        lastTranscriptAt: null,
        transcriptLagBytes: 0,
        hookCoverage: 'none' as const,
        eventsComplete: true,
        usageComplete: true,
      },
      cwd: 'FIXTURE/cwd',
      gitBranch: 'fixture-branch',
      permissionMode: 'default',
    };
    const prompt = redactLine({
      type: 'session',
      data: { ...base, label: 'FIXTURE text', labelSource: 'first_prompt' },
    });
    const rule = redactLine({ type: 'session', data: { ...base, label: 'FIXTURE rule label', labelSource: 'rule' } });
    expect(prompt).toMatchObject({
      type: 'session',
      data: {
        label: '',
        projectId: projectPseudonym('fixture-project'),
        projectLabel: null,
        cwd: null,
        gitBranch: null,
      },
    });
    expect(rule).toMatchObject({ data: { label: 'FIXTURE rule label', permissionMode: 'default' } });
    const noProject = redactLine({
      type: 'session',
      data: { ...base, projectId: null, projectLabel: null, label: '', labelSource: 'none' },
    });
    expect(noProject).toMatchObject({ data: { projectId: null } });
    // the redacted line is still a line of the format
    expect(ExportLineSchema.safeParse(prompt).success).toBe(true);
  });

  it('keeps the agent type as the label, and takes the name from the workflow of an agent and from a workflow run', () => {
    const agent = redactLine({
      type: 'agent',
      data: {
        id: 'agent-1',
        seq: 0,
        sessionId: 'cccccccc-0000-4000-8000-000000000001',
        kind: 'subagent',
        depth: 1,
        parentAgentId: 'main',
        parentToolUseId: null,
        agentType: 'general-purpose',
        label: 'FIXTURE helper',
        workflow,
        requestShape: null,
        model: null,
        startedAt: '2026-10-20T10:00:00.000Z',
        lastActivityAt: '2026-10-20T11:00:00.000Z',
        endedAt: null,
        state,
        usage,
        toolCallCount: 0,
        errorCount: 0,
        transcript: null,
      },
    });
    expect(agent).toMatchObject({
      data: { label: 'general-purpose', workflow: { runId: 'wf_x', name: null, phase: 'p' } },
    });
    const untyped = redactLine({
      type: 'agent',
      data: {
        id: 'agent-2',
        seq: 0,
        sessionId: 'cccccccc-0000-4000-8000-000000000001',
        kind: 'subagent',
        depth: 1,
        parentAgentId: 'main',
        parentToolUseId: null,
        agentType: null,
        label: 'FIXTURE typed by a person',
        workflow: null,
        requestShape: null,
        model: null,
        startedAt: '2026-10-20T10:00:00.000Z',
        lastActivityAt: '2026-10-20T11:00:00.000Z',
        endedAt: null,
        state,
        usage,
        toolCallCount: 0,
        errorCount: 0,
        transcript: null,
      },
    });
    expect(untyped).toMatchObject({ data: { label: 'agent-2', workflow: null } });
    const run = redactLine({
      type: 'workflow',
      data: {
        runId: 'wf_x',
        seq: 0,
        sessionId: 'cccccccc-0000-4000-8000-000000000001',
        name: 'FIXTURE name',
        state,
        agentCount: null,
        started: 0,
        results: 0,
        failed: 0,
        startedAt: null,
        endedAt: null,
      },
    });
    expect(run).toMatchObject({ data: { name: null } });
  });
});

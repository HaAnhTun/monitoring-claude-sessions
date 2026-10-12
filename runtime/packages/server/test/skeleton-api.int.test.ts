// LF-5: walking-skeleton smoke at the API level (no browser). A real instance is started through the real CLI
// (`init`, `configure`, `start`), fed by a small FIXTURE transcript tree, and read back over HTTP. The values it must report
// come from a naive calculation over the fixture files (helpers/skeleton-instance.ts), not from the code under test.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ErrorEnvelopeSchema, routes } from '@mcs/shared';
import { httpRequest } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startSkeletonInstance,
  type ExpectedSession,
  type ExpectedUsage,
  type SkeletonInstance,
} from './helpers/skeleton-instance.ts';

const WEB_INDEX = fileURLToPath(new URL('../../web/dist/index.html', import.meta.url));

let instance: SkeletonInstance;

beforeAll(async () => {
  instance = await startSkeletonInstance();
}, 180_000);

afterAll(async () => {
  await instance.stop();
}, 60_000);

/** The counters of a `TokenUsage` as the helper spells them. */
function usageOf(usage: {
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
  total: number | null;
  turns: number;
}): ExpectedUsage {
  return {
    input: usage.input ?? -1,
    output: usage.output ?? -1,
    cacheCreation: usage.cacheCreation ?? -1,
    cacheRead: usage.cacheRead ?? -1,
    total: usage.total ?? -1,
    turns: usage.turns,
  };
}

function expectedSession(id: string): ExpectedSession {
  const found = instance.expected.sessions.find((session) => session.id === id);
  if (found === undefined) throw new Error(`no expected session ${id}`);
  return found;
}

describe('walking skeleton, API level', () => {
  it('lists both fixture sessions with label, state and token totals', async () => {
    const reply = await instance.getJson(`${routes.listSessions.path}?includeTotal=1`);
    expect(reply.status, `GET ${routes.listSessions.path}`).toBe(200);
    const page = routes.listSessions.response.parse(reply.body);
    expect(page.items.map((item) => item.id).sort()).toEqual(instance.expected.sessions.map((s) => s.id).sort());
    for (const item of page.items) {
      const want = expectedSession(item.id);
      expect(item.label, `label of ${item.id}`).toBe(want.label);
      expect(item.matched).toBe(true);
      expect(item.state.state, `state of ${item.id}`).toBe(want.state);
      expect(item.pendingTools, `pendingTools of ${item.id}`).toBe(want.pendingTools);
      expect(item.agentCount, `agentCount of ${item.id}`).toBe(want.agentCount);
      expect(item.toolCallCount, `toolCallCount of ${item.id}`).toBe(want.toolCalls.length);
      expect(usageOf(item.usage), `own usage of ${item.id}`).toEqual(want.own);
      expect(usageOf(item.usageInclSubagents), `usage incl. subagents of ${item.id}`).toEqual(want.inclSubagents);
    }
  });

  it('shows metadata, tool calls and the token summary of the first session', async () => {
    const want = instance.expected.sessions[0];
    const path = routes.getSession.path.replace(':sessionId', want.id);
    const detailReply = await instance.getJson(path);
    expect(detailReply.status, `GET ${path}`).toBe(200);
    const detail = routes.getSession.response.parse(detailReply.body);
    expect(detail.id).toBe(want.id);
    expect(detail.label).toBe(want.label);
    expect(detail.provider).toBe('claude-code');
    expect(detail.state.state).toBe(want.state);
    expect(detail.cwd, 'cwd comes from the fixture records').toContain('FIXTURE');
    expect(detail.files.map((file) => file.kind).sort()).toEqual(['session', 'subagent']);
    expect(detail.files.every((file) => file.behindBytes === 0)).toBe(true);
    expect(usageOf(detail.usage)).toEqual(want.own);
    expect(usageOf(detail.usageInclSubagents)).toEqual(want.inclSubagents);

    const callsPath = routes.sessionToolCalls.path.replace(':sessionId', want.id);
    const callsReply = await instance.getJson(callsPath);
    expect(callsReply.status, `GET ${callsPath}`).toBe(200);
    const calls = routes.sessionToolCalls.response.parse(callsReply.body).items;
    expect(calls.map((call) => call.toolUseId).sort()).toEqual(want.toolCalls.map((call) => call.toolUseId).sort());
    for (const expectedCall of want.toolCalls) {
      const call = calls.find((candidate) => candidate.toolUseId === expectedCall.toolUseId);
      expect(call?.name, `tool name of ${expectedCall.toolUseId}`).toBe(expectedCall.name);
      expect(call?.outcome, `outcome of ${expectedCall.name}`).toBe(expectedCall.isError === true ? 'error' : 'ok');
      expect(call?.status, `status of ${expectedCall.name}`).toBe(
        expectedCall.isError === true ? 'failed' : 'succeeded',
      );
      expect(call?.agentId, `agent of ${expectedCall.name}`).toBe(expectedCall.agentId);
    }

    // The results themselves come from the transcript window of the main agent.
    const windowPath = routes.transcriptWindow.path.replace(':sessionId', want.id);
    const windowReply = await instance.getJson(windowPath);
    expect(windowReply.status, `GET ${windowPath}`).toBe(200);
    const events = routes.transcriptWindow.response.parse(windowReply.body).events;
    const results = events
      .filter((entry) => entry.k === 'result')
      .map((entry) => ({ text: entry.text, err: entry.err === true }));
    const mainResults = want.toolCalls
      .filter((call) => call.agentId === 'main' && call.resultText !== null)
      .map((call) => ({ text: call.resultText ?? '', err: call.isError === true }));
    expect(results).toEqual(mainResults);
    expect(events.filter((entry) => entry.k === 'tool').map((entry) => entry.name)).toEqual(
      want.toolCalls.filter((call) => call.agentId === 'main').map((call) => call.name),
    );
  });

  it('answers 403 host_not_allowed to a foreign Host header', async () => {
    const reply = await httpRequest(instance.port, routes.listSessions.path, { host: 'evil.example' });
    expect(reply.status).toBe(403);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code).toBe('host_not_allowed');
  });

  it.skipIf(!existsSync(WEB_INDEX))('serves the web index at GET /', async () => {
    const reply = await httpRequest(instance.port, '/', { headers: { Accept: 'text/html' } });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toContain('text/html');
    expect(reply.body).toContain('<div id="root"');
  });
});

describe('skeleton harness option portRange', () => {
  it('allocates the instance port inside the requested range', async () => {
    const ranged = await startSkeletonInstance({ portRange: [18490, 18499] });
    try {
      expect(ranged.port).toBeGreaterThanOrEqual(18490);
      expect(ranged.port).toBeLessThanOrEqual(18499);
      expect((await ranged.getJson(routes.health.path)).status).toBe(200);
    } finally {
      await ranged.stop();
    }
  }, 180_000);
});

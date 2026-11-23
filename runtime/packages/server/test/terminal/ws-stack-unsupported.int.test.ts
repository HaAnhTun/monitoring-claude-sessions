// Stack variant of the unavailable terminal (CAW-57, design 08 section 3.5, id TC-WS-12): an instance whose host cannot run a
// terminal still boots and serves the monitor; the state says why, and every terminal route answers `terminal_unavailable`
// without starting, attaching or killing anything. Design 02's suite scripts the capabilities; here the REAL engine decides them:
// the harness lets the engine select the backend of a platform itself (`backend: 'platform'`), exactly as a real instance does.
//   - On a host without a terminal in this release (Linux and macOS: the Docker target of the gates runs this file there) the
//     first test is the real thing: the platform of the host, the real selection, the reason `unsupported_os`.
//   - On Windows the same selection is run with an injected platform, and the host platform itself is shown without its addon
//     (`addon_missing`): the harness has no addon to load, so no real terminal can start on any host.
import { hostPlatform, type HostPlatform } from '@mcs/engine';
import {
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
  type TerminalUnavailableReason,
} from '@mcs/shared';
import { RawWsClient, assertPortClosed } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { pageOrigin } from './helpers/auth.ts';
import { closeTerminalHarnesses, startTerminalHarness, type TerminalHarness } from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

// FIXTURE: an invented session id and name
const SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SESSION_NAME = 'work-1';

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** This release ships a terminal for Windows only (spec Q1): every other platform is `unsupported_os`. */
function shipsTerminalFor(platform: HostPlatform): boolean {
  return platform === 'win32';
}

/** Everything TC-WS-12 asks of an instance that cannot run a terminal, for one reason. */
async function expectUnavailable(h: TerminalHarness, reason: TerminalUnavailableReason): Promise<void> {
  // boot and health are unaffected, and the instance is a user instance with its access routes
  const health = await h.http('GET', routes.health.path, { cookie: null });
  expect(health.status, health.body).toBe(200);
  expect((await h.http('GET', routes.instance.path, { cookie: null })).json).toMatchObject({ kind: 'user' });
  expect((await h.http('GET', routes.authSession.path)).json).toEqual({ authenticated: true });
  expect((await h.http('GET', routes.overview.path, { cookie: null })).status).toBe(200);

  // the state answers and says why; it offers nothing
  const reply = await h.http('GET', routes.terminalState.path);
  expect(reply.status, reply.body).toBe(200);
  const state = TerminalStateSchema.parse(reply.json);
  expect(state.capabilities).toEqual({
    available: false,
    reason,
    folderPicker: false,
    resume: false,
    maxSessions: 0,
  });
  expect(state.sessions).toEqual([]);

  // every terminal write is refused with the one code, and nothing is started
  const writes: readonly (readonly [string, unknown])[] = [
    [routes.terminalCreateSession.path, { path: h.work }],
    [buildPath(routes.terminalKillSession, { name: SESSION_NAME }), {}],
    [routes.terminalPickFolder.path, {}],
    [routes.terminalResume.path, { sessionId: SESSION_ID }],
    [routes.terminalOpenNative.path, { sessionId: SESSION_ID }],
  ];
  for (const [path, body] of writes) {
    const refused = await h.http('POST', path, { body });
    expect(refused.status, path).toBe(ERROR_HTTP_STATUS.terminal_unavailable);
    expect(codeOf(refused), path).toBe('terminal_unavailable');
  }
  // the socket too: the envelope, no 101
  const socket = await RawWsClient.connect(h.port, {
    path: buildPath(routes.terminalSocket, { name: SESSION_NAME }),
    cookie: h.cookie,
    origin: pageOrigin(h.port),
  });
  expect(socket.status).toBe(ERROR_HTTP_STATUS.terminal_unavailable);
  expect(codeOf(socket)).toBe('terminal_unavailable');
  expect(h.backend.spawns).toHaveLength(0);
  expect(h.ports.sessions.list()).toEqual([]);
  expect(h.ports.census.count()).toBe(0);

  // the guards come first all the same: without a cookie the answer is the 401, not the reason
  const anonymous = await h.http('GET', routes.terminalState.path, { cookie: null });
  expect(anonymous.status).toBe(ERROR_HTTP_STATUS.access_required);
  // the folder list of the sidebar does not depend on a terminal
  expect((await h.http('GET', routes.listFolders.path)).status).toBe(200);

  // and the instance shuts down clean: nothing was started that a stop would have to end
  await expect(h.close()).resolves.toBeUndefined();
  await assertPortClosed(h.port);
}

describe('an instance whose host cannot run a terminal', () => {
  it('TC-WS-12: on the platform of this host the real selection of the engine decides: unsupported_os without a shipped terminal, addon_missing without the addon', async () => {
    const h = await startTerminalHarness({ backend: 'platform' });
    await expectUnavailable(h, shipsTerminalFor(hostPlatform) ? 'addon_missing' : 'unsupported_os');
  });

  it.each(['linux', 'darwin'] as const)(
    'TC-WS-12: with the injected platform %s the state says unsupported_os and nothing is offered',
    async (platform) => {
      expect(shipsTerminalFor(platform)).toBe(false);
      const h = await startTerminalHarness({ backend: 'platform', platform });
      await expectUnavailable(h, 'unsupported_os');
    },
  );

  it('TC-WS-12: the same instance with a terminal is available, so the refusals above are the host and nothing else', async () => {
    const h = await startTerminalHarness();
    const state = TerminalStateSchema.parse((await h.http('GET', routes.terminalState.path)).json);
    expect(state.capabilities).toMatchObject({ available: true, reason: null, resume: true });
    expect(state.capabilities.maxSessions).toBeGreaterThan(0);
    const made = await h.http('POST', routes.terminalCreateSession.path, { body: { path: h.work } });
    expect(made.status, made.body).toBe(200);
    expect(h.backend.spawns).toHaveLength(1);
  });
});

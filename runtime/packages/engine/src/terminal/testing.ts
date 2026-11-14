// The entry point `@mcs/engine/testing`: the scripted pseudo terminal, so that tests of the server (WebSocket, routes) and of
// the engine drive terminal sessions without ConPTY. No production entry imports this file; the bundle never contains it.
export { FAKE_KILLED_EXIT_CODE, FakePty, FakePtyBackend } from './fake-pty.ts';
export type { FakePtyBackendOptions, FakePtyOptions, FakeSpawn } from './fake-pty.ts';

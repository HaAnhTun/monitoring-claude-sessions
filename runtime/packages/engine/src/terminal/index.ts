// The terminal module of the engine (design 01 section 3): every module of the folder, in one place. The engine barrel
// (`engine/src/index.ts`) does not export it: what lives outside the engine reaches the terminal through `@mcs/engine/testing`
// (the scripted pseudo terminal, which this file leaves out on purpose so that no production entry can pull it in) or through the
// user-instance host, which exports its own surface.
//
// Importing this file loads nothing native and starts nothing: the addon is loaded by `createNodePtyBackend` and `diagnoseTerminal`
// when they are called, by path, from `node-pty-loader.ts`.
export * from './command.ts';
export * from './default.ts';
export * from './diagnose.ts';
export * from './env.ts';
export * from './errors.ts';
export * from './folder.ts';
export * from './folder-picker.ts';
export * from './host.ts';
export * from './limits.ts';
export * from './manager.ts';
export * from './names.ts';
export * from './native-terminal.ts';
export * from './native-targets.ts';
export * from './node-pty-backend.ts';
export * from './node-pty-loader.ts';
export * from './registry.ts';
export * from './replay.ts';
export * from './session.ts';
export * from './types.ts';
export * from './unsupported-backend.ts';

// Flat config for the runtime workspace. Layering and safety rules are documented in
// docs/design/05-tooling-testing-security.md section 2.6; change both together.
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Matches the Node built-in modules and nothing else: `node:*`, or a built-in name at the start of the specifier, optionally with
 * a subpath (`stream`, `stream/web`, `fs/promises`). A gitignore-style group would also match any path with a segment of that name
 * (a web folder `src/stream`, CR-WP-48-1), so this is an anchored regex.
 */
const NODE_BUILTIN_BASES = [
  ...new Set(builtinModules.filter((m) => !m.startsWith('_') && !m.startsWith('node:')).map((m) => m.split('/')[0])),
];
const NODE_BUILTIN_REGEX = `^(?:node:|(?:${NODE_BUILTIN_BASES.join('|')})(?:/|$))`;
const nodeBuiltins = (message) => ({ regex: NODE_BUILTIN_REGEX, message });

/** Packages that must never be added (stack-versions.md section 9, ADR-0041). */
const BANNED_PACKAGES = [
  'axios',
  'node-fetch',
  'lodash',
  'moment',
  'date-fns',
  'uuid',
  'dotenv',
  'commander',
  'yargs',
  'ws',
  'socket.io',
  'cors',
  'body-parser',
  'jsdom',
  'rehype-raw',
  'marked',
  'markdown-it',
  'ts-node',
  'tsx',
  'pino',
].map((name) => ({ name, message: 'Banned dependency (see ADR-0041 avoid list).' }));

const DEEP_IMPORTS = [
  {
    group: ['@mcs/*/src/*', '@mcs/*/dist/*'],
    message: 'Import a package through its exports map, never by file path.',
  },
  {
    regex: '^(\\.\\./)+(shared|engine|server|cli|web|testkit)/',
    message: 'Do not reach into another workspace package with a relative path; import @mcs/<name>.',
  },
];

/**
 * Builds one complete `no-restricted-imports` entry. Flat config replaces a rule per block, so every
 * block must carry the global bans plus its own.
 */
function restrictImports({ paths = [], patterns = [] } = {}) {
  return ['error', { paths: [...BANNED_PACKAGES, ...paths], patterns: [...DEEP_IMPORTS, ...patterns] }];
}

const forbid = (names, message) => ({ group: names, message });

const UNSAFE_HTML_SYNTAX = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Do not inject raw HTML; render text or sanitized markdown elements.',
  },
  {
    selector: 'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'Do not assign HTML strings to the DOM.',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Do not write HTML strings to the DOM.',
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: 'Do not write HTML strings to the DOM.',
  },
];

const NO_SHELL_SYNTAX = [
  {
    selector: "Property[key.name='shell'][value.value=true]",
    message: 'Child processes run without a shell: pass an argv array.',
  },
];

const CHILD_PROCESS_UNSAFE = {
  name: 'node:child_process',
  importNames: ['exec', 'execSync'],
  message: 'exec/execSync go through a shell; use execFileText from @mcs/engine.',
};

const NO_STDIO = [
  { object: 'process', property: 'stdout', message: 'Write output through the CLI terminal module or the logger.' },
  { object: 'process', property: 'stderr', message: 'Write output through the CLI terminal module or the logger.' },
];

/** Platform branching lives in engine/src/platform/** (06-panels-parity-platform.md section 4, critic I-34). */
const PLATFORM_ENTRY = {
  object: 'process',
  property: 'platform',
  message: 'Branch on the platform only in engine/src/platform/** (import hostPlatform from platform/host.ts).',
};

const OS_PLATFORM_SYNTAX = {
  selector: "CallExpression[callee.object.name='os'][callee.property.name='platform']",
  message: 'Branch on the platform only in engine/src/platform/** (import hostPlatform from platform/host.ts).',
};

const WEB_SYNTAX = [
  {
    selector: 'JSXAttribute[name.name=/^(href|src|srcDoc|formAction|action)$/] > JSXExpressionContainer',
    message: 'No computed href/src: build internal links with router Link from ids.',
  },
  { selector: "JSXAttribute[name.name='target'][value.value='_blank']", message: 'The UI renders no external links.' },
];

/** Web import rule; flags lift single exceptions owned by one file (04-ui.md section 8). */
function webImports({ lucide = false, extra = [] } = {}) {
  return restrictImports({
    paths: [{ name: 'react-router-dom', message: 'Use react-router (v8 single package).' }],
    patterns: [
      nodeBuiltins('web runs in the browser.'),
      forbid(
        ['@mcs/engine', '@mcs/server', '@mcs/cli', '@mcs/testkit', 'express', 'better-sqlite3', 'zod'],
        'web imports only @mcs/shared (schemas come from shared).',
      ),
      forbid(
        ['react-markdown', 'remark*', 'rehype*', 'dompurify'],
        'Markdown is the ported legacy subset (04-ui.md section 8).',
      ),
      ...(lucide ? [] : [forbid(['lucide-react'], 'Icons come from src/components/icons.ts only.')]),
      forbid(['**/test/**', '**/fixtures/**'], 'Production code never imports test code or fixtures.'),
      ...extra,
    ],
  });
}

const WEB_GLOBALS = {
  fetch: 'Only src/data/api-client.ts calls fetch.',
  EventSource: 'Only src/stream/stream-client.ts opens EventSource.',
  localStorage: 'Only src/lib/prefs.ts touches storage.',
  sessionStorage: 'Only src/lib/prefs.ts touches storage.',
};

function webGlobals(...allowed) {
  return [
    'error',
    ...Object.entries(WEB_GLOBALS)
      .filter(([name]) => !allowed.includes(name))
      .map(([name, message]) => ({ name, message })),
  ];
}

const SRC = (pkg) => `packages/${pkg}/src/**/*.{ts,tsx}`;
const TEST_FILES = [
  '**/*.test.{ts,tsx}',
  'packages/*/test/**/*.ts',
  'packages/web/src/test/**/*.{ts,tsx}',
  'tests/**/*.ts',
  'packages/web/e2e/**/*.ts',
];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '.dev/**',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': restrictImports({ paths: [CHILD_PROCESS_UNSAFE] }),
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // ---- layering: shared is isomorphic and depends on nothing internal
  {
    files: [SRC('shared')],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          nodeBuiltins('shared is isomorphic: no Node built-ins.'),
          forbid(['@mcs/*', 'express', 'better-sqlite3', 'react', 'react-*'], 'shared depends only on zod.'),
        ],
      }),
    },
  },
  {
    files: ['packages/shared/src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          nodeBuiltins('protocol is dependency-free.'),
          forbid(['@mcs/*', 'zod', 'express', 'better-sqlite3', 'react'], 'protocol is dependency-free.'),
          { regex: '^\\.\\./', message: 'protocol must not import the zod-based part of shared.' },
        ],
      }),
    },
  },
  // ---- engine: Node domain; no HTTP, no UI, no CLI
  {
    files: [SRC('engine')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Only engine/src/db/driver.ts opens the driver.' },
          { name: 'node:child_process', message: 'Only engine/src/platform/exec.ts starts processes.' },
          { name: 'child_process', message: 'Use node:child_process inside engine/src/platform/exec.ts only.' },
        ],
        patterns: [
          forbid(
            ['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit', 'express', 'react', 'react-*'],
            'engine must not depend on server, cli, web or test code.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO, PLATFORM_ENTRY],
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX, OS_PLATFORM_SYNTAX],
    },
  },
  {
    // allow-list of the platform rule; re-declares the stdio and base syntax entries (a later block replaces rule options)
    files: ['packages/engine/src/platform/**/*.ts', 'packages/engine/src/security/paths.ts'],
    rules: {
      'no-restricted-properties': ['error', ...NO_STDIO],
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX],
    },
  },
  {
    files: ['packages/engine/src/db/driver.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [forbid(['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit'], 'engine layering')],
        paths: [CHILD_PROCESS_UNSAFE],
      }),
    },
  },
  {
    files: ['packages/engine/src/platform/exec.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          CHILD_PROCESS_UNSAFE,
          { name: 'better-sqlite3', message: 'Only engine/src/db/driver.ts opens the driver.' },
        ],
        patterns: [forbid(['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit'], 'engine layering')],
      }),
    },
  },
  {
    files: ['packages/engine/src/log/logger.ts'],
    rules: { 'no-restricted-properties': ['error', PLATFORM_ENTRY] },
  },
  // ---- server: HTTP over engine; never the driver, never processes
  {
    files: [SRC('server')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Use engine repositories.' },
          { name: 'node:child_process', message: 'The server never starts processes.' },
          { name: 'child_process', message: 'The server never starts processes.' },
        ],
        patterns: [
          forbid(
            ['@mcs/cli', '@mcs/web', '@mcs/testkit', 'react', 'react-*'],
            'server depends on engine and shared only.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO],
    },
  },
  // ---- cli: commands over engine; output through io/terminal.ts only
  {
    files: [SRC('cli')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Use engine repositories.' },
          { name: 'node:child_process', message: 'Use execFileText/spawnDetached from @mcs/engine.' },
          { name: 'child_process', message: 'Use execFileText/spawnDetached from @mcs/engine.' },
        ],
        patterns: [
          forbid(
            ['@mcs/server', '@mcs/web', '@mcs/testkit', 'express', 'react', 'react-*'],
            'cli depends on engine and shared only.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO],
    },
  },
  {
    files: ['packages/cli/src/io/terminal.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['packages/cli/src/hook.ts', 'packages/cli/src/hook/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          {
            regex: '^(?!node:|@mcs/shared/protocol$|\\./)',
            message: 'The hook handler imports only node:* and @mcs/shared/protocol (fast start, no zod).',
          },
        ],
      }),
    },
  },
  // ---- web: browser only, talks to the server over HTTP, imports only shared (rules from 04-ui.md section 8)
  {
    files: [SRC('web')],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'no-script-url': 'error',
      'no-restricted-imports': webImports(),
      'no-restricted-globals': webGlobals(),
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...WEB_SYNTAX],
    },
  },
  { files: ['packages/web/src/components/icons.ts'], rules: { 'no-restricted-imports': webImports({ lucide: true }) } },
  { files: ['packages/web/src/data/api-client.ts'], rules: { 'no-restricted-globals': webGlobals('fetch') } },
  {
    files: ['packages/web/src/stream/stream-client.ts'],
    rules: { 'no-restricted-globals': webGlobals('EventSource') },
  },
  {
    files: ['packages/web/src/lib/prefs.ts'],
    rules: { 'no-restricted-globals': webGlobals('localStorage', 'sessionStorage') },
  },
  {
    files: ['packages/web/src/lib/**/*.ts'],
    rules: {
      'no-restricted-imports': webImports({
        extra: [
          forbid(['react', 'react-dom', 'react-router', '@tanstack/*'], 'lib/ is pure: no React, router or query.'),
        ],
      }),
    },
  },
  // ---- tests: assertions allowed, no sleeps, fixtures from testkit
  {
    files: TEST_FILES,
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': restrictImports(),
      'no-restricted-syntax': [
        'error',
        ...UNSAFE_HTML_SYNTAX,
        ...NO_SHELL_SYNTAX,
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'No sleeps in tests: use fake timers or waitFor() from @mcs/testkit.',
        },
      ],
    },
  },
  {
    files: ['packages/web/src/**/*.test.tsx', 'packages/web/src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // ---- plain JS tooling (scripts/, config files)
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);

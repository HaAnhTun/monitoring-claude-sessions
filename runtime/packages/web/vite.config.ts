// Web build and dev server (04-ui.md section 12.2, ADR 0039). The `resolve.conditions` line lets dev, test and build read the
// workspace TypeScript sources without a prior `tsc -b` (ADR 0040); the API default never points at the owner's live monitor.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Runs the bundle budget (scripts/check-bundle-budget.mjs) after every production build, so `npm run build -w @mcs/web`
 * fails over budget even though the package.json `build` script is `vite build` only (change request CR-WP-44-1).
 */
function bundleBudget(): Plugin {
  const script = fileURLToPath(new URL('./scripts/check-bundle-budget.mjs', import.meta.url));
  return {
    name: 'mcs-bundle-budget',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        const result = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: process.cwd() });
        if (result.status !== 0) throw new Error('Bundle budget check failed (see the table above).');
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MCS_');
  // Server started by `npm run dev` (05 3.1, port range 18760-18769). Never 8765: that is the owner's live legacy monitor.
  const api = env['MCS_DEV_API'] ?? 'http://127.0.0.1:18765';
  return {
    plugins: [react(), bundleBudget()],
    base: '/',
    // Workspace packages resolve to their TypeScript sources: no prior `tsc -b` for dev or build (05 2.8, ADR 0040).
    resolve: { conditions: ['@mcs/source', ...defaultClientConditions] },
    // The same for suites that run in the node environment (`// @vitest-environment node`): Vitest resolves those through the SSR
    // conditions. Only the custom condition, as in the root vitest.config.ts (an `import` flag would reach the node workers).
    ssr: { resolve: { conditions: ['@mcs/source'] } },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      sourcemap: false,
      manifest: true,
      // No inline polyfill: Chrome, Edge and Firefox support modulepreload.
      modulePreload: { polyfill: false },
      target: 'es2022',
      cssCodeSplit: true,
      reportCompressedSize: true,
    },
    define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(env['MCS_BUILD_ID'] ?? 'dev') },
    server: {
      host: '127.0.0.1',
      port: Number(env['MCS_WEB_DEV_PORT'] ?? '18766'),
      strictPort: true,
      proxy: {
        '/api': {
          target: api,
          // Host must match the server's guard (03 5.2 step 2).
          changeOrigin: true,
          // The terminal socket (`/api/v3/terminal/sessions/:name/socket`, ADR 0087) is a WebSocket upgrade under /api.
          ws: true,
          configure: (proxy) => {
            // Origin guard (03 5.2 step 3): present the target origin, as a same-origin browser would.
            proxy.on('proxyReq', (req) => {
              if (req.getHeader('origin') !== undefined) req.setHeader('origin', api);
            });
            // The same for the upgrade request: the server compares the Origin of a handshake with its own (ADR 0087), and the
            // browser's is the dev server's. A handshake without an Origin (not a browser) is left as it is.
            proxy.on('proxyReqWs', (req) => {
              if (req.getHeader('origin') !== undefined) req.setHeader('origin', api);
            });
          },
        },
      },
    },
    preview: { host: '127.0.0.1', port: Number(env['MCS_WEB_PREVIEW_PORT'] ?? '18767'), strictPort: true },
  };
});

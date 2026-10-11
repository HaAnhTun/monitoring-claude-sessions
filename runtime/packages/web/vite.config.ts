// Stub for the scaffold check. The real file is owned by 04-ui.md section 12.2; it must keep the
// `resolve.conditions` line (workspace sources without a prior build) and must never default to port 8765.
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MCS_');
  const api = env['MCS_DEV_API'] ?? 'http://127.0.0.1:18765';
  return {
    plugins: [react()],
    base: '/',
    resolve: { conditions: ['@mcs/source', ...defaultClientConditions] },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, manifest: true, modulePreload: { polyfill: false } },
    server: {
      host: '127.0.0.1',
      port: Number(env['MCS_WEB_DEV_PORT'] ?? '18766'),
      strictPort: true,
      proxy: {
        '/api': {
          target: api,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (req) => {
              if (req.getHeader('origin') !== undefined) req.setHeader('origin', api);
            });
          },
        },
      },
    },
  };
});

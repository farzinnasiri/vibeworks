import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { CONTRACT_FILES, workspaceFingerprint } from './src/bridge/fingerprint.ts';
import { bridgePort, webPort } from './src/bridge/config.ts';

export default defineConfig(() => {
  const contractPaths = CONTRACT_FILES.map(path => fileURLToPath(new URL(path, import.meta.url)));
  return {
    define: { __VIBEWORKS_FINGERPRINT__: JSON.stringify(workspaceFingerprint()) },
    plugins: [react(), {
      name: 'vibeworks-contract-reload',
      configureServer(server) { server.watcher.add(contractPaths); },
      async handleHotUpdate(context) {
        if (contractPaths.includes(context.file)) {
          // A contract change needs a fresh bundle fingerprint and a full tab reload.
          await context.server.restart();
          return [];
        }
      },
    }],
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['replicad-opencascadejs'] },
    server: {
      host: '127.0.0.1', port: webPort(), strictPort: true,
      proxy: {
        '/api/runtime': {
          target: `ws://127.0.0.1:${bridgePort()}`, ws: true, changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/api': {
          target: `http://127.0.0.1:${bridgePort()}`,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    preview: { host: '127.0.0.1', port: webPort(), strictPort: true },
  };
});

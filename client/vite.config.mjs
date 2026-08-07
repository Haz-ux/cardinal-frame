import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

export default defineConfig({
  define: {
    // Single source of truth for the app version — read from the repo's
    // package.json at build time so it can never drift out of date again.
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [
    react(),
    {
      name: 'request-logger',
      configureServer(server) {
        server.httpServer.on('request', (req, res) => {
          console.log(`[vite] ${req.method} ${req.url} (host=${req.headers.host || '-'}, origin=${req.headers.origin || '-'}, conn=${req.headers.connection || '-'})`);
        });
      },
    },
  ],
  server: {
    port: 5173,
    host: '::1', // this phone's browser resolves localhost → ::1 (IPv6); vite must listen there or localhost:5173 refuses to connect.
    // NOTE: do NOT use a wildcard host ('::', '0.0.0.0', 'localhost') — vite's resolveServerUrls calls os.networkInterfaces(),
    // which the proot sandbox blocks (uv_interface_addresses error 13). IPv4 loopback is served by client/vite-ipv4-forward.mjs.
    strictPort: true, // fail hard if 5173 is busy instead of silently bumping to 5174+
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log(`[api-proxy] -> target ${req.method} ${req.url} (origin=${req.headers.origin || '-'}, conn=${req.headers.connection || '-'})`);
          });
          proxy.on('proxyReqError', (err, req) => {
            console.error(`[api-proxy] req ERROR ${err.code || err.message} ${req.method} ${req.url}`);
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log(`[api-proxy] <- ${req.method} ${req.url} => ${proxyRes.statusCode}`);
          });
          proxy.on('error', (err, req) => {
            console.error(`[api-proxy] error ${err.code || err.message} ${req.method} ${req.url}`);
          });
        },
      },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          // XYFlow + d3 + force-graph — graph rendering, only loaded on /dags and /neural routes
          if (
            id.includes('/@xyflow/') ||
            id.includes('/d3-') ||
            id.includes('delaunator') ||
            id.includes('robust-predicates') ||
            id.includes('/react-force-graph-2d/') ||
            id.includes('/force-graph/') ||
            id.includes('/react-kapsule/') ||
            id.includes('/kapsule/') ||
            id.includes('/accessor-fn/') ||
            id.includes('/index-array-by/') ||
            id.includes('/canvas-color-tracker/') ||
            id.includes('/@tweenjs/') ||
            id.includes('/zustand/') ||
            id.includes('/classcat/') ||
            id.includes('/bezier-js/') ||
            id.includes('/float-tooltip/') ||
            id.includes('/lodash-es/')
          ) {
            return 'vendor-xyflow';
          }
          // Lucide icons — separate for cache isolation
          if (id.includes('/lucide-react/')) {
            return 'vendor-lucide';
          }
          // React Router + Remix
          if (id.includes('/react-router') || id.includes('/@remix-run/')) {
            return 'vendor-router';
          }
          // React core + all other vendor (merged to avoid circular deps)
          return 'vendor-react';
        },
      },
    },
    chunkSizeWarningLimit: 300,
  },
});

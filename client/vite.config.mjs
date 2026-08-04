import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true, secure: false },
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

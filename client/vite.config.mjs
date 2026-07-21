import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, secure: false },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          // d3-force — shared by NeuralMap and DAGEditor, isolated to avoid
          // rollup mis-matching its exports against xyflow's own re-exports
          if (id.includes('/d3-force/') || id.includes('/d3-force-') || id.includes('/d3-quadtree/') || id.includes('/d3-collection/') || id.includes('/d3-dispatch/') || id.includes('/d3-timer/')) {
            return 'vendor-d3-force';
          }
          // XYFlow + remaining d3 — only loaded on /dags route
          if (id.includes('/@xyflow/') || id.includes('/d3-') || id.includes('delaunator') || id.includes('robust-predicates')) {
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

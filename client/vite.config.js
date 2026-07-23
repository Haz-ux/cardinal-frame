import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import compression from 'vite-plugin-compression';
import imagemin from 'vite-plugin-imagemin';

export default defineConfig({
  plugins: [
    react(),
    compression({
      dropElement: true,
    }),
    imagemin({
      gifsicle: { interlaced: true },
      mozjpeg: { quality: 75 },
      optipng: { quality: [0.7, 0.9] },
      svgo: {},
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
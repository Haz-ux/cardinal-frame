const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');
const { tailwindcss } = require('@tailwindcss/vite');

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
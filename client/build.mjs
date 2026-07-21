#!/usr/bin/env node
/**
 * Cardinal Frame — Production Build Script
 * 
 * Uses Vite API directly to ensure vendor code splitting works.
 * The `vite build` CLI doesn't properly apply manualChunks with
 * Vite 5's dep pre-bundling, so we use the programmatic API.
 */

import { build } from 'vite';

const root = import.meta.dirname || process.cwd();

console.log('🔨 Building Cardinal Frame client...\n');

const result = await build({
  root,
  configFile: root + '/vite.config.mjs',
  logLevel: 'info',
});

// Print chunk summary
if (result && Array.isArray(result.output)) {
  const chunks = result.output
    .filter(c => c.type === 'chunk')
    .sort((a, b) => b.code.length - a.code.length);

  const vendorChunks = chunks.filter(c => c.name.includes('vendor'));
  const pageChunks = chunks.filter(c => !c.name.includes('vendor'));

  console.log('\n📦 Vendor Chunks:');
  for (const c of vendorChunks) {
    console.log(`   ${c.name.padEnd(16)} ${(c.code.length / 1024).toFixed(1)}KB`);
  }

  console.log('\n📄 Page Chunks (lazy-loaded):');
  for (const c of pageChunks.filter(c => c.isDynamicEntry)) {
    console.log(`   ${c.name.padEnd(16)} ${(c.code.length / 1024).toFixed(1)}KB`);
  }

  const entryChunk = chunks.find(c => c.isEntry);
  if (entryChunk) {
    console.log(`\n🚀 Entry: ${(entryChunk.code.length / 1024).toFixed(1)}KB`);
  }

  const totalJS = chunks.reduce((s, c) => s + c.code.length, 0);
  console.log(`\n✅ Total JS: ${(totalJS / 1024).toFixed(1)}KB`);
}

# Cardinal Frame — Agent Memory

## Project
- Cardinal Frame: lightweight AI orchestration layer
- Stack: Vite+React+Tailwind (client), Express+SQLite WAL (server)
- Build: node client/build.mjs (programmatic Vite, manualChunks)
- Auth: bcrypt + JWT, rate-limited (20/min)

## Architecture
- Code-split with lazy loading — entry ~49KB, vendor chunks separate
- dataCache.js: SWR-style caching (15s TTL), prewarmed on login
- WebSocket: singleton WS with broadcast for telemetry + state updates
- Neural Map: react-force-graph-2d, workspace file scanner + import links

## Jetson Environment
- Tegra L4 5.15.185 — ARM64
- tegrastats for GPU/NPU/temp polling
- 16GB RAM, CUDA capable

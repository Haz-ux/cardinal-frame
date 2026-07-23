# Contributing to Cardinal Frame

## Setup
```bash
git clone https://github.com/Haz-ux/cardinal-frame.git
cd cardinal-frame
npm install
cd client && npm install && cd ..
cp .env.example .env  # edit with your JWT_SECRET and API keys
```

## Development
```bash
# Start server (port 8080)
node src/server/server.mjs

# Build client
node client/build.mjs

# Run tests
npx vitest run

# Run a specific test
npx vitest run tests/auth.test.mjs
```

## Testing
- **Framework:** Vitest + supertest
- **Test files:** `tests/*.test.mjs`
- **Pattern:** Each test file gets its own temp DB, seeded by migrations
- **Coverage:** 17 files, 288 tests
- Always run `npx vitest run` before committing — all tests must pass

## Build
```bash
node client/build.mjs   # Vite build → client/dist/
```
Output: 796KB total across 29 chunks, 51.8KB entry. Code-split with lazy loading.

## Docker
```bash
docker compose build
docker compose up -d
# App runs on http://localhost:8080
```

## Database Migrations
- SQL files in `src/server/migrations/`, numbered `001_*.sql`, `002_*.sql`, etc.
- Runner: `src/server/migrator.mjs` — auto-runs on server start
- Tracked in `_migrations` table
- Idempotent: safe to re-run

## Commits
- Follow conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`
- Run tests before every commit
- Don't commit notes, plans, or working docs — `.gitignore` blocks `*.md` except README, ARCHITECTURE, CONTRIBUTING

## Project Structure
See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system overview.

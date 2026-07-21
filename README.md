# Cardinal Frame

A lightweight, feature‑rich AI orchestration layer built with React (Vite) for the frontend and Express for the backend. This repository demonstrates a clean project structure, CI/CD pipeline, and a simple dashboard that can be expanded into a full‑featured orchestration platform.

## Table of Contents

- [Features](#features)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development](#development)
- [Building for Production](#building-for-production)
- [Backend API](#backend-api)
- [CI/CD](#ci-cd)
- [License](#license)

## Features

- **React + Vite** frontend with TypeScript support
- **Express** backend exposing a health check and dashboard summary endpoint
- **CI/CD** via GitHub Actions (lint, build, test)
- Modular component architecture (custom header, layout, pages)
- Extensible API for future AI‑orchestration features

## Project Structure

```
cardinal-frame/
├─ .github/
│  └─ workflows/
│     └─ ci.yml                # GitHub Actions workflow
├─ public/
│  └─ index.html
├─ src/
│  ├─ components/
│  │  └─ CustomHeader.tsx      # Header component (logo, nav)
│  ├─ pages/
│  │  └─ Dashboard.tsx         # Dashboard page (placeholder data)
│  ├─ App.tsx                  # Root component
│  └─ main.tsx                 # React entry point
├─ server/
│  └─ server.mjs               # Express backend
├─ .gitignore
├─ package.json
├─ README.md
├─ design.md
└─ agent.md
```

## Getting Started

1. **Clone the repo**

   ```bash
   git clone https://github.com/your-username/cardinal-frame.git
   cd cardinal-frame
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the development server**

   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:5174`.

4. **Run the backend server**

   ```bash
   npm run start:server
   ```

   The API will listen on `http://localhost:3000`.

## Development

- **Hot Module Replacement (HMR)** is enabled out of the box.
- Edit files in `src/` and the changes will appear instantly in the browser.
- Use `npm run lint` to check code style.
- Run `npm test` (placeholder) when you add tests.

## Building for Production

```bash
npm run build
```

The production build is output to the `dist/` directory. You can serve it with any static web server (e.g., `npm run preview`).

## Backend API

| Endpoint                | Method | Description                              |
|-------------------------|--------|------------------------------------------|
| `GET /api/health`       | GET    | Returns a simple health status JSON.     |
| `GET /api/dashboard/summary` | GET | Returns mock dashboard summary data.    |

### Example response (`/api/dashboard/summary`)

```json
{
  "activeAgents": 5,
  "totalTasks": 120,
  "uptimeHours": 48,
  "npuUtilization": "68%",
  "cpuLoad": "35%"
}
```

The backend runs on **port 3000** by default (environment variable `PORT` can override it).

## CI/CD

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and pull request to `main`/`master`. It performs:

1. Checkout the repository.
2. Cache `node_modules` for faster builds.
3. Set up Node.js 20.
4. Install dependencies (`npm ci`).
5. Run ESLint (`npm run lint`).
6. Build the frontend (`npm run build`).
7. Execute tests (`npm test`).

## License

MIT © 2026 Cardinal Frame Contributors

---

*Feel free to open an issue or submit a pull request if you’d like to extend the platform!*

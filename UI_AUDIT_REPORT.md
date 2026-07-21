# Cardinal Frame — UI Improvement Audit Report

**Date:** 2026-05-31  
**Scope:** All 18 client `.jsx`/`.js` files + `index.css`  
**Focus:** Missing features, cyberpunk/neon visual polish, interactions, empty/loading/error states, accessibility

---

## Executive Summary

The Cardinal Frame client has a solid cyberpunk foundation — dark backgrounds, neon accent colors, glowing borders, and animated elements. However, the implementation is inconsistent across pages, several critical UX patterns are missing (loading states, error feedback, toast notifications), the login page breaks the neon aesthetic entirely, the DAG editor is barely functional, and accessibility is near-zero. Below is a page-by-page prioritized list of concrete improvements.

---

## 🔴 P0 — Critical (Breaks UX / Missing Core Patterns)

### G1: No Toast / Notification System (Global)
- **Every page** silently swallows errors with `catch(() => {})` or `catch(err => console.error(err))`. Users get zero feedback on success or failure of any action (create, delete, toggle, upload, etc.).
- **Fix:** Add a global `<ToastProvider>` + `useToast()` hook. Show neon-styled toast notifications (green glow for success, red glow for error, cyan for info) with auto-dismiss.

### G2: No Page-Level Loading States (All Pages Except Dashboard)
- Every page starts with `const [items, setItems] = useState([])` and immediately renders empty-state UI ("No X found") before data loads. Users see a flash of "No agents registered" then it populates — looks broken.
- **Fix:** Add `const [loading, setLoading] = useState(true)` to every page. Show skeleton placeholders or `<PageLoader />` during initial fetch. Only show empty states after loading completes with zero results.

### G3: Quick Actions Broken Navigation (Dashboard)
- `navigateTo()` uses `window.history.pushState + PopStateEvent` hack that doesn't work with React Router's `BrowserRouter`. Clicking "Register Agent", "New Task", etc. may not navigate.
- **Fix:** Use `useNavigate()` from `react-router-dom` (already imported in App.jsx).

### G4: No Delete Confirmation (Most Pages)
- Only `Users.jsx` uses `confirm()` for delete. Tasks, Agents, Groups, MCP Servers, DAGs, Files, Schedules, LLM Providers, and Plugins all delete immediately on click — one misclick destroys data.
- **Fix:** Add a neon-styled confirmation modal or at minimum a `confirm()` dialog for all destructive actions.

### G5: NEON Palette Duplicated 11 Times
- The `NEON` constant is copy-pasted into every single page file with slight inconsistencies (some have `magenta`, some don't; some have `red`, some don't).
- **Fix:** Extract to `src/theme.js` and import everywhere. Ensures consistency and single source of truth.

---

## 🟠 P1 — High (Major Visual / Feature Gaps)

### Login.jsx — Complete Aesthetic Disconnect
- **Problem:** Login uses standard `bg-gray-950`, `bg-gray-800`, `border-gray-700`, blue/amber/green buttons — completely different from the cyberpunk dark+neon theme used everywhere else.
- **Fix:** Redesign all login phases (select, password, login, register, reset) with:
  - Dark background `#050510` with radial cyan/purple gradients (matching main layout)
  - Neon-glowing input fields (`border: 1px solid ${NEON.cyan}30`, focus glow)
  - Neon accent buttons (cyan for login, green for register, amber for reset)
  - Animated grid lines or particle background
  - The "Cardinal Frame" title should use the same gradient text as the sidebar

### Dashboard.jsx — Missing Features vs Hermes
- No **recent tasks** list with status pills (Hermes shows latest tasks on dashboard)
- No **agent status grid** with mini-cards per agent (Hermes shows agent health at a glance)
- No **token usage / cost tracking** cards (Hermes has spend dashboards)
- Activity Feed has no **event type filter** (AuditLog has one, Dashboard doesn't)
- Sparkline data only starts after page load — no history on refresh
- **Fix:** Add recent tasks section, agent mini-grid, and a token-cost summary card. Persist sparkline history to `localStorage`.

### DAGEditor.jsx — Barely Functional
- Nodes render as flat cards in a `flex-wrap` layout — no actual **graph visualization** (no SVG edges, no drag-to-connect, no spatial layout)
- Every node has a static `ArrowRight` icon regardless of edges
- `saveDAG()` just calls `alert('DAG saved successfully!')` — doesn't actually save
- No way to **create edges** between nodes
- No **drag-and-drop** to reposition nodes
- No **run/execute** DAG button
- **Fix:** Implement a real canvas-based DAG editor (reactflow or custom SVG canvas) with draggable nodes, SVG edge rendering, connection handles, and actual save API call.

### Tasks.jsx — Missing Interactions
- No **pagination** — renders all tasks at once (scalability issue)
- No **sort** controls (by name, date, priority, status)
- No **assign to agent** action (the `task:assigned` event type exists but no UI for it)
- No **cancel/stop** running tasks
- No **log streaming** view for running tasks (WebSocket supports `task:log` but no log viewer)
- **Fix:** Add pagination, sort dropdown, assign-to-agent modal, cancel button for running tasks, and a collapsible log viewer.

### Agents.jsx — Missing Features vs Hermes
- No **agent detail page** — clicking an agent just toggles a tiny inline panel
- No **configuration editing** (system prompt, model, temperature, etc.)
- No **task history** per agent
- No **real-time log** viewer
- No **agent type** distinction (Hermes has different agent types with icons)
- **Fix:** Add a full agent detail view/modal with config editor, task history tab, and live log tab.

### CyberMascotCompanion.jsx — Simulated Only
- All responses are random canned phrases — no actual LLM connection
- No context awareness (doesn't know about current tasks, agents, or system state)
- Quick action buttons ("Status", "Tasks", "Agents") just insert text, don't trigger actions
- **Fix:** Connect to a real chat/completion endpoint. Inject dashboard context. Make quick actions navigate to pages or trigger real queries.

---

## 🟡 P2 — Medium (Visual Polish & Interaction Refinement)

### Global — Cyberpunk Aesthetic Gaps
- **No scanline/CRT overlay** — a subtle repeating scanline pattern on the main content area would dramatically enhance the cyberpunk feel
- **No grid/circuit background** — the main area has only a subtle radial gradient; a faint hex/circuit grid SVG pattern would add depth
- **No glitch/flicker animations** — titles and key elements could have occasional subtle glitch effects (CSS `clip-path` animation)
- **No neon pulse on data changes** — when values update (via WebSocket), cards should briefly pulse brighter
- **Fix:** Add `@keyframes` for scanline, glitch, and data-pulse to `index.css`. Add a subtle overlay div in the Layout component.

### Sidebar (App.jsx) — Polish
- Admin nav items (Audit, Users) use `#888` — they look disabled/grayed out compared to the neon-colored items above
- **Fix:** Give admin items distinct colors (Audit: `NEON.orange`, Users: `NEON.pink`)
- `NEON.red` is referenced on line 140 (`ShieldCheck`) but never defined in App.jsx's NEON object — causes undefined color
- **Fix:** Add `red: '#ef4444'` to App.jsx NEON

### PageLoader.jsx — Aesthetic Mismatch
- Uses generic gray (`bg-gray-800`, `bg-gray-700`) — clashes with the neon theme
- "Loading chunk…" text is in blue, not neon cyan
- **Fix:** Restyle with dark backgrounds and neon cyan/purple skeleton bars. Replace "Loading chunk…" with a neon spinner + "LOADING" in tracking-wider font.

### LLMProviders.jsx — Improvements
- Model list hard-capped at 50 with "+N more" text — no "show all" or pagination
- Provider cards hard-cap expanded models at 20 with no expand-all
- No **model cost/token info** display
- No **test connection** button per provider
- No **reorder/drag** providers
- **Fix:** Add "Show all models" expand, test-connection button, and cost display per model.

### Schedules.jsx — Improvements
- No **run now** button (manual trigger)
- No **next run time** calculation/display
- No **run history** per schedule
- Cron expression input has no **visual builder** — just raw text
- **Fix:** Add "Run Now", show calculated next-run time, add a visual cron builder (minute/hour/day dropdowns), and show last N run results.

### MCP.jsx — Improvements
- No **SSE transport** option in Connect modal — only `stdio`
- No **resource/prompt** display (MCP protocol has resources and prompts beyond tools)
- No **tool execution** UI — can see tools but can't invoke them
- No **connection logs** / error details
- **Fix:** Add transport selector, resources/prompts tabs, tool invocation form, and error log display.

### Files.jsx — Improvements
- No **directory/folder** structure — flat file list only
- No **drag-and-drop** upload zone (only a button + hidden input)
- No **download** button — can preview but can't save
- No **image preview** rendering (shows raw text for images)
- Upload doesn't use auth token (plain `fetch` instead of `api()`)
- **Fix:** Add folder nav, drag-drop zone, download link, image preview rendering, and auth header on upload.

### AgentGroups.jsx — Improvements
- No **edit group name/description** after creation
- No **add member** button on existing groups (only in create modal)
- No **broadcast task** action to a group
- Loading members makes N sequential API calls (`/api/groups/${id}` for each group) — very slow
- **Fix:** Add inline edit, add-member button, broadcast action, and a batch endpoint for members.

### AuditLog.jsx — Improvements
- No **pagination** — renders all entries
- No **real-time** updates via WebSocket (Dashboard has WS, Audit doesn't)
- Header uses `#888` color instead of a neon accent — looks washed out vs other pages
- **Fix:** Add pagination, WS subscription for new entries, and restyle header with `NEON.orange` or `NEON.cyan`.

### Plugins.jsx — Improvements
- No **plugin marketplace/registry** browse UI
- No **plugin configuration** editor (just displays raw JSON)
- No **plugin logs** or health status details
- **Fix:** Add config editor form, health status indicators, and logs tab.

### Users.jsx — Improvements
- No **password change** for existing users
- No **user detail** page (last login, actions, etc.)
- No **disable/lock** user (only delete)
- Edit role inline UI is cramped (tiny select + ✓/✗ buttons)
- No **auto-refresh** (other pages poll on intervals; Users doesn't)
- **Fix:** Add password reset, disable toggle, user detail modal, and polling.

---

## 🔵 P3 — Low (Nice-to-Have / Accessibility / Code Quality)

### Accessibility (All Pages) — Near Zero
- **No `aria-label`** on interactive elements except the hamburger menu button
- **No keyboard navigation** — no `tabIndex` management, no focus trapping in modals
- **No screen reader** text for status indicators (the colored dots mean nothing to SR)
- **No `role` attributes** on custom widgets
- **No focus-visible** styling — impossible to tell where keyboard focus is
- **No skip-to-content** link
- **Fix:** Add aria-labels to all buttons, focus trapping in modals, sr-only text for status, focus-visible outlines in neon, and skip-to-content link.

### Index.css — Only 1 Line
- `@import "tailwindcss"` — all styling is inline `style={{}}` props
- No custom CSS for: scrollbars (beyond Dashboard's inline), animations, focus states, selection colors, scanline overlay
- **Fix:** Move common neon styles to CSS classes. Add custom scrollbar styling, selection color (`::selection { background: ${NEON.cyan}40 }`), and animation keyframes.

### Form Validation (All Modals)
- No client-side validation feedback — inputs just silently fail if empty
- No red border on invalid fields
- No password strength indicator on Register/Reset
- **Fix:** Add field-level validation with neon error styling.

### Responsive Design Gaps
- Files: date column hides on mobile but no alternative view
- Tasks: status/created columns hide on small screens — no mobile card view
- LLM: model table truncates on mobile
- **Fix:** Add mobile-optimized card views that replace tables on small screens.

### WebSocket (useWebSocket.js)
- No **reconnection backoff** — fixed 3s retry
- No **connection status** UI outside Dashboard (Users, Audit, Files, Plugins don't show WS state)
- No **message queue** — messages sent while disconnected are lost
- **Fix:** Add exponential backoff, global WS status indicator in sidebar, and offline message queue.

### Code Quality
- `AuthContext.jsx` defines `api()` and also `Login.jsx` defines its own local `api()` — duplicate with different auth behavior
- `AuthContext.jsx` has `saveUser()` duplicated from `Login.jsx`
- Inline `onMouseEnter`/`onMouseLeave` handlers everywhere for hover effects — should use CSS `:hover`
- Many `catch(() => {})` silently swallow errors — should at minimum log to a monitoring endpoint

---

## Priority Matrix

| Priority | Count | Key Themes |
|----------|-------|------------|
| 🔴 P0 | 5 | Toast system, loading states, broken nav, delete confirm, theme dedup |
| 🟠 P1 | 6 | Login redesign, DAG editor, task log viewer, agent details, Aimi LLM, dashboard gaps |
| 🟡 P2 | 9 | Cyberpunk overlays, per-page feature gaps (schedules, MCP, files, etc.) |
| 🔵 P3 | 6 | Accessibility, CSS extraction, form validation, responsive, WS robustness |

---

## Recommended Implementation Order

1. **Extract `theme.js`** — NEON palette + shared styles (enables all other work)
2. **Build `<ToastProvider>`** — unlocks user feedback on every page
3. **Add loading states** to all pages — kills the "flash of empty state"
4. **Redesign Login.jsx** — biggest visual disconnect, first thing users see
5. **Fix Dashboard navigation** — broken quick actions
6. **Add delete confirmations** — prevents data loss
7. **Add cyberpunk overlays** — scanlines, grid background, glitch titles
8. **Rebuild DAG editor** — most broken page, needs real graph UI
9. **Add task log viewer + agent detail view** — core feature gaps
10. **Connect Aimi to real LLM** — currently just random text

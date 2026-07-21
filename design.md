# Cardinal Frame Design Document

## 1. Overview
Cardinal Frame is a lightweight AI orchestration platform that allows registration of AI agents, monitoring of their health, management and execution of tasks, and creation/execution of DAG workflows. It provides a RESTful API with SQLite persistence, JWT authentication, WebSocket real-time updates, and a React frontend with visual DAG editing.

## 2. Architecture
- **Backend**: Node.js + Express (REST API + WebSocket) — `src/server/server.mjs`
- **Frontend**: Vite + React + TypeScript + Tailwind — `src/`
- **Database**: SQLite via better-sqlite3 (`src/data/cardinal.db`) — WAL mode, survives restarts
- **Auth**: JWT (HS256) with Bearer tokens — register/login endpoints
- **Real-time**: WebSocket (`/ws`) — broadcasts task/DAG/agent status changes
- **Communication**: HTTP/JSON + WebSocket; CORS enabled; Vite dev proxy for `/api/*` + `/ws`
- **Deployment**: Docker container (planned) — backend serves static React build

## 3. Architecture Diagram

```
+-------------------+ HTTP/JSON +WS+ +-------------------+
| React Frontend | <-----------> | Express Server |
| (Vite + React) | /api/* /ws | (Node.js) |
| Dashboard | | Agents CRUD |
| Tasks (CRUD+Run) | | Tasks CRUD+Exec |
| Agents (CRUD) | | DAGs CRUD+Run |
| DAG Editor | | JWT Auth |
| Login/Register | | WebSocket Hub |
+-------------------+ +-------------------+
 |
 v
 +-------------------+
 | SQLite Database |
 | cardinal.db (WAL) |
 | users, agents, |
 | tasks, dags |
 +-------------------+
```

## 4. API Endpoints

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Create account, get JWT |
| POST | `/api/auth/login` | No | Login, get JWT |
| GET | `/api/auth/me` | Required | Get current user profile |

### Health & Dashboard
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check (db, ws status) |
| GET | `/api/dashboard/summary` | No | System metrics overview |

### Agents
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/agents` | Required | Register agent |
| GET | `/api/agents` | Optional | List agents |
| GET | `/api/agents/:id` | Optional | Get agent details |
| GET | `/api/agents/:id/heartbeat` | Optional | Update heartbeat |
| DELETE | `/api/agents/:id` | Required | Delete agent |

### Tasks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/tasks` | Required | Create task |
| GET | `/api/tasks` | Optional | List tasks (query: `?status=`, `?search=`) |
| GET | `/api/tasks/:id` | Optional | Get task details |
| GET | `/api/tasks/:id/logs` | Optional | Get task execution logs |
| PATCH | `/api/tasks/:id/execute` | Required | Execute task command |
| PATCH | `/api/tasks/:id/cancel` | Required | Cancel a running task |
| POST | `/api/tasks/:id/retry` | Required | Retry a failed/cancelled/done task |
| PATCH | `/api/tasks/:id/assign` | Required | Assign task to agent |
| DELETE | `/api/tasks/:id` | Admin | Delete task |

### Agents
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/agents` | Required | Register agent |
| GET | `/api/agents` | Optional | List agents (query: `?status=`, `?search=`) |
| GET | `/api/agents/:id` | Optional | Get agent details |
| GET | `/api/agents/:id/heartbeat` | Optional | Update heartbeat |
| GET | `/api/agents/:id/tasks` | Optional | Get agent task history (last 50) |
| POST | `/api/agents/:id/claim` | Required | Agent claims next pending task |
| POST | `/api/agents/:id/report/:taskId` | Required | Agent reports task result |
| DELETE | `/api/agents/:id` | Admin | Delete agent |

### Users (RBAC)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users` | Admin | List all users |
| PATCH | `/api/users/:id/role` | Admin | Change user role |

### Audit Log
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/audit` | Admin | List last 200 audit entries |
| GET | `/api/audit/:resourceType/:resourceId` | Required | Audit entries for specific resource |

### DAGs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/dags` | Required | Create DAG |
| GET | `/api/dags` | Optional | List DAGs |
| GET | `/api/dags/:id` | Optional | Get DAG details |
| PUT | `/api/dags/:id` | Required | Update DAG |
| DELETE | `/api/dags/:id` | Required | Delete DAG |
| POST | `/api/dags/:id/run` | Required | Execute DAG (topo sort) |

### WebSocket
| Path | Description |
|------|-------------|
| `/ws` | Real-time status updates |

**Event types**: `task:created`, `task:status`, `task:deleted`, `task:assigned`, `task:log`, `agent:created`, `agent:heartbeat`, `agent:deleted`, `dag:created`, `dag:updated`, `dag:status`, `dag:deleted`, `dag:layer`, `connected`

**Subscription**: Clients send `{ type: "subscribe", taskId }` or `{ type: "unsubscribe", taskId }` to receive `task:log` events for specific tasks.

## 5. Data Schema (SQLite)

### users
- `id` TEXT PK, `username` TEXT UNIQUE, `password_hash` TEXT, `role` TEXT, `created_at` TEXT

### agents
- `id` TEXT PK, `name` TEXT, `version` TEXT, `capabilities` TEXT (JSON), `status` TEXT, `registered_at` TEXT, `last_heartbeat` TEXT

### tasks
- `id` TEXT PK, `name` TEXT, `command` TEXT, `status` TEXT (pending/running/done/failed), `result` TEXT, `exit_code` INT, `created_at` TEXT, `started_at` TEXT, `finished_at` TEXT, `user_id` TEXT, `assigned_agent_id` TEXT

### task_logs
- `id` INTEGER PK AUTOINCREMENT, `task_id` TEXT, `stream` TEXT (stdout/stderr), `line` TEXT, `ts` TEXT

### audit_log
- `id` INTEGER PK AUTOINCREMENT, `action` TEXT, `resource_type` TEXT, `resource_id` TEXT, `user_id` TEXT, `details` TEXT (JSON), `ts` TEXT

### dags
- `id` TEXT PK, `name` TEXT, `nodes` TEXT (JSON), `edges` TEXT (JSON), `status` TEXT, `last_run_result` TEXT (JSON), `created_at` TEXT, `updated_at` TEXT, `user_id` TEXT

## 6. Auth Flow
1. Client sends `POST /api/auth/login` with `{username, password}`
2. Server validates, returns JWT + user object
3. Client stores token in `localStorage` (`cf_token`)
4. All write endpoints require `Authorization: Bearer <token>` header
5. Read endpoints accept optional auth
6. Default admin account: `admin` / `admin`

## 7. Frontend Pages
- **Login**: Auth form (register/login toggle), stored in `cf_token`
- **Dashboard**: System metrics + WebSocket connection indicator + real-time activity feed
- **Tasks**: TaskForm + TaskList with live WS status, execute/cancel/retry buttons, expandable log viewer (subscribes to WS task:log), search + status filter
- **Agents**: AgentForm (with capabilities) + AgentList + Claim button + Heartbeat + expandable task history
- **Audit Log** (admin only): Filterable audit trail of all platform mutations
- **DAG Editor**: DAGBuilder canvas + sidebar list + save/run/delete
- **Users** (admin only): User list, role selector (admin/user/viewer), permission reference

## 8. Sprint History
- **Sprint 1**: CRUD endpoints, React scaffold, Vite proxy
- **Sprint 2**: Task execution, JSONL persistence, DAG CRUD + execution
- **Sprint 3**: SQLite, JWT auth, WebSocket real-time updates, Login page
- **Sprint 4**: bcrypt password hashing, rate limiting, full React frontend (Tailwind + React Router + React Flow DAG editor), production static serving
- **Sprint 5**: Task log streaming (WebSocket subscribe/broadcast), DAG parallel execution (topological layers with fan-out), Agent task assignment (claim/report/assign), RBAC (admin/user/viewer roles + requireRole middleware + Users admin page)
- **Sprint 6–7**: Schedules, MCP client, Agent Groups, File I/O, Plugins system, CLI, full test suite (59/59 passing)
- **Sprint 8**: Dashboard activity feed (real-time WS event log), Task cancel + retry endpoints & UI, Agent detail view with task history, Audit log table + API + admin UI, Search/filter on Tasks & Agents lists

## 9. Next Sprint Options
- MCP client for real tool discovery
- Docker containerization
- Task log retention policy and log pruning
- Agent health monitoring (auto-inactive after missed heartbeats)
- DAG parallel execution with configurable concurrency limits
- Task dependency graph (tasks can depend on other tasks)
- File upload/download for task I/O

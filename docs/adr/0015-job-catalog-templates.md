# ADR-0015: Job Catalog — Reusable Task Templates

**Date:** 2026-07-24

## Context

The task system (`/api/tasks`, `/api/dags`) supports creating and running individual commands and DAGs, but there's no way to save, share, or reuse common job patterns. Users recreate the same tasks manually, and there's no AI-assisted discovery of reusable patterns from task execution history.

## Decision

Add a **Job Catalog** — a template system layer on top of the existing task infrastructure.

### Schema

- `job_catalog` table: name, description, command (with `{{param}}` placeholders), parameters (JSON array), category, tags, priority, timeout_ms, use_count, source ('manual' | 'ai-suggested')

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/job-catalog` | List templates (filter: category, search) |
| `GET /api/job-catalog/:id` | Single template |
| `POST /api/job-catalog` | Create template |
| `PUT /api/job-catalog/:id` | Update template |
| `DELETE /api/job-catalog/:id` | Delete template |
| `POST /api/job-catalog/:id/instantiate` | Create a task from template (with param substitution + auto-execute) |
| `POST /api/job-catalog/suggest` | AI analyzes task history → suggests templates |
| `POST /api/job-catalog/import` | Import an AI-suggested template |
| `GET /api/job-catalog/categories` | Distinct categories with counts |

### AI Suggestion Flow

1. Query `tasks` table for completed tasks grouped by command, frequency-sorted
2. Send task history to `callAgentLLM` with a system prompt identifying Aimi as Cardinal Frame's AI
3. LLM returns JSON array of template suggestions with parameterized commands
4. User reviews suggestions in UI, clicks "Import" for ones they want
5. Imported templates have `source = 'ai-suggested'`

### Parameter Substitution

Templates use `{{paramName}}` placeholders. On instantiation:
- Required params validated
- Values substituted, shell metacharacters stripped for safety
- Existing `sanitizeCommand` validates the final command
- Task created via existing `stmts.tasks.insert` — no new execution path

### Frontend

Added a view toggle on the Tasks page: **Tasks** | **Templates**. Templates view shows:
- Category filter pills
- Search bar
- Template list with name, command, category badge, use count, AI-suggested indicator
- Instantiate (▶) and Delete actions per template
- "AI Suggest" button → modal showing LLM-generated suggestions with import
- "New Template" button → modal for manual template creation

## Consequences

- +16 tests (all passing)
- No changes to existing task execution paths
- `callAgentLLM` failures in `/suggest` degrade gracefully (503 or raw response)
- Use count tracking enables sorting templates by popularity
- `source` field distinguishes manual vs AI-suggested templates

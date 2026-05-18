# Coding Broker

Local Agent broker with a Vite frontend and a Go backend.

## Backend

The backend uses chi for HTTP routing, slog with tint for logs, viper for configuration, and SQLite for persistence.

```bash
go run ./cmd/coding-broker
```

Configuration is loaded from `coding-broker.yaml`, `config/coding-broker.yaml`, or `CODING_BROKER_*` environment variables. See `coding-broker.example.yaml`.

Important defaults:

- HTTP: `127.0.0.1:8787`
- SQLite: `./data/coding-broker.db`; custom paths like `~/Library/coding-broker.db` are supported.
- Workspace browser root: your home directory when `workspace.root` is `.` or blank; custom roots like `~/Code` are supported.
- Worktrees: `./data/worktrees`; custom roots like `~/Broker/worktrees` are supported.
- Codex command: `codex` with no extra args
- Agent idle timeout: `10m` without any agent events; active runs continue as long as Codex keeps producing events.

Conversation modes are `ask`, `plan`, and `act`. Ask and Plan use Codex suggest mode. Act uses Codex full-auto mode for project edits, verification, and Git operations when the user asks. Each session owns a worktree from creation time, so review and publish stay scoped to that session.

The frontend dev server proxies `/api` and `/healthz` to this backend. MSW is opt-in for frontend-only work with `VITE_USE_MSW=true`.

## Core API

- `GET /healthz`
- `GET /api/config`
- `GET /api/directories`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{slug}`
- `POST /api/projects/{slug}/git/pull`
- `GET /api/projects/{slug}/git/worktrees`
- `POST /api/projects/{slug}/git/worktrees`
- `PATCH /api/projects/{slug}/git/worktrees/{worktreeID}`
- `DELETE /api/projects/{slug}/git/worktrees/{worktreeID}`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `DELETE /api/sessions/{id}`
- `PATCH /api/sessions/{id}`
- `PATCH /api/sessions/{id}/mode`
- `PATCH /api/sessions/{id}/model`
- `POST /api/sessions/{id}/cancel`
- `POST /api/sessions/{id}/messages`
- `POST /api/sessions/{id}/permissions/{permissionID}`
- `GET /api/sessions/{id}/git/diff`
- `POST /api/sessions/{id}/git/publish`

Response shape notes:

- Project list/detail endpoints return full project detail objects with Git status and public worktree summaries.
- `POST /api/projects` and session create/update endpoints return persisted base records, not detail objects.
- `GET /api/sessions/{id}` returns `{ session, project, messages, permissions }` and includes the session's public `worktree` summary.
- Worktree responses expose `id`, `projectSlug`, `name`, `branch`, `path`, `status`, `lastUsedAt`, and publish metadata such as `commitSha`, `pushed`, and pull request fields when available.

# Coding Broker Frontend Demo

Responsive local Agent proxy demo built with React, Vite, and shadcn/ui. In normal development it talks to the Go backend through the Vite `/api` proxy.

## Flow

- `/agents` is the Cursor-style Agents View: a task composer plus agent/session queue.
- `/sessions/:sessionId` opens one persistent agent thread with a bottom composer. Ask, Plan, and Act are selected from the composer mode Select, not separate tab pages.
- Sessions require a project context at creation time. After a session exists, the project context is read-only.
- Each session owns a worktree from creation time, and session Git review/publish stays inside that thread.
- `/projects` lists registered local Git folders for context selection.
- `/projects/:projectSlug` shows standalone project Git and worktree state, but project pages are secondary to the agent workflow.

## Backend API

Start the Go backend from the repository root:

```bash
go run ./cmd/coding-broker
```

Then start the frontend:

```bash
pnpm dev
```

Vite proxies `/api` and `/healthz` to `http://127.0.0.1:8787`.

## Mock API

MSW is still available for isolated frontend work, but it is opt-in:

```bash
VITE_USE_MSW=true pnpm dev
```

The mock layer handles:

- `GET /api/config`
- `GET /api/directories`
- `GET /api/projects`
- `GET /api/projects/:slug`
- `POST /api/projects`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `PATCH /api/sessions/:id`
- `PATCH /api/sessions/:id/mode`
- `PATCH /api/sessions/:id/model`
- `POST /api/sessions/:id/cancel`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/permissions/:permissionID`
- `GET /api/sessions/:id/git/diff`
- `POST /api/sessions/:id/git/publish`
- `POST /api/projects/:slug/git/pull`
- `GET/POST/PATCH/DELETE /api/projects/:slug/git/worktrees`

The demo does not call the real filesystem or real Git. Runtime-created sessions and worktrees are in-memory mock state.

The mock response shapes mirror the backend API: project lists return full project details, session detail responses wrap the base session record with messages and permissions, and worktrees use the public worktree summary fields.

## Run

```bash
pnpm install
pnpm dev
```

## Verify

```bash
pnpm typecheck
pnpm lint
pnpm build
```

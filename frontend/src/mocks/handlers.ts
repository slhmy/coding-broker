import { delay, http, HttpResponse } from "msw"

import { appConfig, gitStatuses, projects, sessions, worktrees } from "@/mocks/data"
import type {
  CreateProjectInput,
  CreateSessionInput,
  CreateWorktreeInput,
  DirectoryBrowseResult,
  DirectoryEntry,
  PermissionStatus,
  ProjectDetail,
  ProjectHealth,
  ProjectRecord,
  SendMessageInput,
  Session,
  Message,
  PermissionRequest,
  SessionRecord,
  UpdateSessionInput,
  Worktree,
} from "@/types/domain"

const runtimeSessions = new Map(sessions.map((session) => [session.id, session]))
let runtimeProjects = [...projects]
let runtimeWorktrees = [...worktrees]

function now() {
  return new Date().toISOString()
}

function compareUpdatedAtThenKey<T extends { updatedAt: string }>(
  left: T,
  right: T,
  leftKey: string,
  rightKey: string
) {
  const updatedAtComparison = compareDesc(left.updatedAt, right.updatedAt)
  if (updatedAtComparison !== 0) {
    return updatedAtComparison
  }
  return compareDesc(leftKey, rightKey)
}

function sortProjectsByStoreOrder(input: ProjectDetail[]) {
  return [...input].sort((left, right) =>
    compareUpdatedAtThenKey(left, right, left.slug, right.slug)
  )
}

function sortSessionsByStoreOrder(input: SessionRecord[]) {
  return [...input].sort((left, right) =>
    compareUpdatedAtThenKey(left, right, left.id, right.id)
  )
}

function sortWorktreesByStoreOrder(input: Worktree[]) {
  return [...input].sort((left, right) => {
    const lastUsedAtComparison = compareDesc(left.lastUsedAt, right.lastUsedAt)
    if (lastUsedAtComparison !== 0) {
      return lastUsedAtComparison
    }
    return compareDesc(left.id, right.id)
  })
}

function sortCreatedAtThenId<T extends { createdAt: string; id: string }>(input: T[]) {
  return [...input].sort((left, right) => {
    const createdAtComparison = compareAsc(left.createdAt, right.createdAt)
    if (createdAtComparison !== 0) {
      return createdAtComparison
    }
    return compareAsc(left.id, right.id)
  })
}

function sortDirectoryEntries(input: DirectoryEntry[]) {
  return [...input].sort((left, right) => {
    const leftName = left.name.toLowerCase()
    const rightName = right.name.toLowerCase()
    if (leftName !== rightName) {
      return compareAsc(leftName, rightName)
    }
    return compareAsc(left.name, right.name)
  })
}

function compareAsc(left: string, right: string) {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function compareDesc(left: string, right: string) {
  return compareAsc(right, left)
}

async function readJSON<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T
  } catch {
    return HttpResponse.json({ message: "invalid JSON" }, { status: 400 })
  }
}

function projectDetail(projectSlug: string): ProjectDetail | null {
  const project = runtimeProjects.find((candidate) => candidate.slug === projectSlug)
  const git = gitStatuses[projectSlug]

  if (!project || !git) {
    return null
  }

  return {
    ...project,
    branch: git.branch,
    health: projectHealth(git),
    worktreeCount: runtimeWorktrees.filter(
      (worktree) => worktree.projectSlug === projectSlug
    ).length,
    git,
    worktrees: sortWorktreesByStoreOrder(
      runtimeWorktrees
        .filter((worktree) => worktree.projectSlug === projectSlug)
        .map((worktree) => mapWorktree(worktree))
    ),
  }
}

function projectHealth(git: { reachable: boolean; dirtyFiles: number; behind: number }): ProjectHealth {
  if (!git.reachable) {
    return "conflict"
  }
  if (git.dirtyFiles > 0) {
    return "changes"
  }
  if (git.behind > 0) {
    return "behind"
  }
  return "clean"
}

function projectRecord(project: { slug: string; name: string; path: string; defaultBranch: string; createdAt: string; updatedAt: string }): ProjectRecord {
  return {
    slug: project.slug,
    name: project.name,
    path: project.path,
    defaultBranch: project.defaultBranch,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function sessionDetail(session: Session) {
  const project = runtimeProjects.find((candidate) => candidate.slug === session.projectSlug)
  if (!project) {
    return null
  }
  const worktree = session.worktreeId
    ? runtimeWorktrees.find((candidate) => candidate.id === session.worktreeId)
    : null

  const detail = {
    session: sessionRecord(session),
    project: projectRecord(project),
    messages: sortCreatedAtThenId<Message>(session.messages),
    permissions: sortCreatedAtThenId<PermissionRequest>(session.permissions),
  }
  return worktree ? { ...detail, worktree: mapWorktree(worktree) } : detail
}

function sessionRecord(session: Session): SessionRecord {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    mode: session.mode,
    model: session.model,
    projectSlug: session.projectSlug,
    worktreeId: session.worktreeId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

function isValidMode(mode: unknown) {
  return mode === "ask" || mode === "plan" || mode === "act"
}

function isActiveSession(session: Session) {
  return session.status === "running"
}

function findPermission(permissionId: string) {
  for (const session of runtimeSessions.values()) {
    const permission = session.permissions.find((candidate) => candidate.id === permissionId)
    if (permission) {
      return { session, permission }
    }
  }
  return null
}

function activeWorktreeIds() {
  return new Set(
    [...runtimeSessions.values()]
      .map((session) => session.worktreeId)
      .filter((worktreeId): worktreeId is string => Boolean(worktreeId))
  )
}

function mapWorktree(worktree: Worktree, activeIds = activeWorktreeIds()): Worktree {
  return {
    ...worktree,
    status: activeIds.has(worktree.id) || worktree.status === "active" ? "active" : worktree.status,
  }
}

function isValidModel(model: unknown): model is string {
  return typeof model === "string" && appConfig.availableModels.includes(model)
}

function normalizeModel(model: unknown) {
  if (typeof model !== "string") {
    return null
  }
  const trimmed = model.trim()
  if (trimmed === "") {
    return appConfig.defaultModel
  }
  return isValidModel(trimmed) ? trimmed : null
}

function isValidWorktreeName(name: unknown) {
  if (typeof name !== "string") {
    return false
  }
  const trimmed = name.trim()
  return (
    trimmed !== "" &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  )
}

function isLikelyBranchName(value: string) {
  return value !== "" && !value.includes("..") && !value.startsWith("/") && !value.endsWith("/")
}

function truncateCharacters(value: string, limit: number) {
  return [...value].slice(0, limit).join("")
}

const mockDirectoryTree: Record<string, string[]> = {
  "/Users/demo": ["Code", "Desktop", "Documents", "Downloads"],
  "/Users/demo/Code": [
    "coding-broker",
    "coding-broker-agent-ui",
    "coding-broker-msw-api",
    "design-system",
    "mobile-app",
    "ops-console",
    "ops-console-main",
  ],
  "/Users/demo/Desktop": ["scratch"],
  "/Users/demo/Documents": ["notes"],
  "/Users/demo/Downloads": [],
  "/Users/demo/Code/coding-broker": ["frontend", "internal"],
  "/Users/demo/Code/coding-broker-agent-ui": [],
  "/Users/demo/Code/coding-broker-msw-api": [],
  "/Users/demo/Code/design-system": [],
  "/Users/demo/Code/mobile-app": [],
  "/Users/demo/Code/ops-console": [],
  "/Users/demo/Code/ops-console-main": [],
  "/Users/demo/Desktop/scratch": [],
  "/Users/demo/Documents/notes": [],
  "/Users/demo/Code/coding-broker/frontend": [],
  "/Users/demo/Code/coding-broker/internal": [],
}

function normalizeMockPath(value: string) {
  return value.replace(/^~(?=\/|$)/, "/Users/demo")
}

function mockDirectories(path: string | null, search: string | null): DirectoryBrowseResult {
  const homePath = "/Users/demo"
  const normalizedPath = path ? normalizeMockPath(path.trim()) : null
  const currentPath = normalizedPath && normalizedPath.startsWith(homePath) ? normalizedPath : homePath
  const searchValue = search?.trim().toLowerCase() ?? ""
  const names = mockDirectoryTree[currentPath] ?? []
  const parentPath = currentPath === homePath ? null : currentPath.split("/").slice(0, -1).join("/")

  return {
    homePath,
    currentPath,
    parentPath,
    entries: sortDirectoryEntries(
      names
        .filter((name) => !searchValue || name.toLowerCase().includes(searchValue))
        .map((name) => {
          const entryPath = `${currentPath}/${name}`
          return {
            name,
            path: entryPath,
            hidden: name.startsWith("."),
            gitRepository: runtimeProjects.some((project) => project.path === entryPath),
            unreadable: false,
          }
        })
    ),
  }
}

export const handlers = [
  http.get("/api/config", async () => {
    await delay(80)
    return HttpResponse.json(appConfig)
  }),

  http.get("/api/directories", async ({ request }) => {
    await delay(120)
    const url = new URL(request.url)
    return HttpResponse.json(
      mockDirectories(url.searchParams.get("path"), url.searchParams.get("search"))
    )
  }),

  http.get("/api/projects", async () => {
    await delay(180)
    const details = runtimeProjects
      .map((project) => projectDetail(project.slug))
      .filter((project): project is ProjectDetail => Boolean(project))
    return HttpResponse.json(sortProjectsByStoreOrder(details))
  }),

  http.post("/api/projects", async ({ request }) => {
    await delay(240)
    const body = await readJSON<CreateProjectInput>(request)
    if (body instanceof Response) {
      return body
    }
    const path = normalizeMockPath(body.path?.trim() ?? "")

    if (!path) {
      return HttpResponse.json({ message: "path is required" }, { status: 400 })
    }

    const name = body.name?.trim() || path.split("/").filter(Boolean).at(-1) || "project"
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
    if (!slug) {
      return HttpResponse.json(
        { message: "project name must contain letters or numbers" },
        { status: 400 }
      )
    }
    const defaultBranch = body.defaultBranch?.trim() || "main"
    if (/\s/.test(defaultBranch)) {
      return HttpResponse.json(
        { message: "defaultBranch must not contain whitespace" },
        { status: 400 }
      )
    }
    if (!isLikelyBranchName(defaultBranch)) {
      return HttpResponse.json(
        { message: "defaultBranch must be a valid branch name" },
        { status: 400 }
      )
    }
    const existingProject = runtimeProjects.find((candidate) => candidate.slug === slug)
    const projectChanged =
      !existingProject ||
      existingProject.name !== name ||
      existingProject.path !== path ||
      existingProject.defaultBranch !== defaultBranch
    const timestamp = now()
    const createdAt = existingProject?.createdAt ?? timestamp
    const updatedAt =
      existingProject && !projectChanged ? existingProject.updatedAt : timestamp
    const project = {
      slug,
      name,
      path,
      description: "Local project managed by Coding Broker.",
      branch: defaultBranch,
      defaultBranch,
      health: "clean" as const,
      createdAt,
      updatedAt,
      worktreeCount: 0,
    }

    runtimeProjects = [
      project,
      ...runtimeProjects.filter((candidate) => candidate.slug !== slug),
    ]
    gitStatuses[slug] = {
      projectSlug: slug,
      branch: project.branch,
      defaultBranch: project.defaultBranch,
      ahead: 0,
      behind: 0,
      dirtyFiles: 0,
      reachable: true,
      message: null,
      lastPulledAt: null,
      pullMessage: null,
    }

    return HttpResponse.json(projectRecord(project), { status: 201 })
  }),

  http.get("/api/projects/:slug", async ({ params }) => {
    await delay(160)
    const detail = projectDetail(String(params.slug))

    if (!detail) {
      return HttpResponse.json({ message: "Project not found" }, { status: 404 })
    }

    return HttpResponse.json(detail)
  }),

  http.get("/api/sessions", async () => {
    await delay(150)
    return HttpResponse.json(
      sortSessionsByStoreOrder(Array.from(runtimeSessions.values()).map(sessionRecord))
    )
  }),

  http.post("/api/sessions", async ({ request }) => {
    await delay(220)
    const body = await readJSON<CreateSessionInput>(request)
    if (body instanceof Response) {
      return body
    }
    const createdAt = now()
    const projectSlug = body.projectSlug.trim()
    const project = runtimeProjects.find((candidate) => candidate.slug === projectSlug)

    if (!project) {
      return HttpResponse.json(
        { message: "projectSlug is required" },
        { status: 400 }
      )
    }
    const sessionModel = body.model === undefined ? appConfig.defaultModel : normalizeModel(body.model)
    if (!sessionModel) {
      return HttpResponse.json({ message: "invalid model" }, { status: 400 })
    }

    const session: Session = {
      id: `ses-${crypto.randomUUID().slice(0, 8)}`,
      title: body.prompt?.trim()
        ? truncateCharacters(body.prompt.trim(), 80)
        : body.useCurrentBranch
          ? "Current branch"
          : `Work on ${project.name}`,
      status: "idle",
      mode: "ask",
      model: sessionModel,
      projectSlug: project.slug,
      createdAt,
      updatedAt: createdAt,
      messages: body.prompt?.trim()
        ? [
            {
              id: `msg-${crypto.randomUUID().slice(0, 8)}`,
              role: "user",
              content: body.prompt.trim(),
              createdAt,
            },
            {
              id: `msg-${crypto.randomUUID().slice(0, 8)}`,
              role: "assistant",
              content: `I will work with ${project.name} as the locked session context. Switch modes any time to ask, plan, or act from the same task.`,
              createdAt,
            },
          ]
        : [
            {
              id: `msg-${crypto.randomUUID().slice(0, 8)}`,
              role: "assistant",
              content: body.useCurrentBranch
                ? `Session ready on ${project.name}'s current branch. Ask, Plan, and Act are available as session modes.`
                : `Session ready for ${project.name}. Ask, Plan, and Act are available as session modes with this locked workspace context.`,
              createdAt,
            },
          ],
      plan: [],
      permissions: [],
    }

    runtimeSessions.set(session.id, session)
    return HttpResponse.json(sessionRecord(session), { status: 201 })
  }),

  http.get("/api/sessions/:id", async ({ params }) => {
    await delay(120)
    const session = runtimeSessions.get(String(params.id))

    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }

    const detail = sessionDetail(session)
    if (!detail) {
      return HttpResponse.json({ message: "Project not found" }, { status: 404 })
    }

    return HttpResponse.json(detail)
  }),

  http.delete("/api/sessions/:id", async ({ params }) => {
    await delay(180)
    const sessionId = String(params.id)
    const session = runtimeSessions.get(sessionId)

    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }

    runtimeSessions.delete(sessionId)
    runtimeWorktrees = runtimeWorktrees.filter(
      (worktree) => worktree.id !== session.worktreeId
    )
    return HttpResponse.json({ ok: true })
  }),

  http.patch("/api/sessions/:id", async ({ params, request }) => {
    await delay(160)
    const session = runtimeSessions.get(String(params.id))
    const body = await readJSON<UpdateSessionInput>(request)
    if (body instanceof Response) {
      return body
    }

    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    const title = body.title?.trim()
    if (body.title !== undefined && !title) {
      return HttpResponse.json({ message: "title is required" }, { status: 400 })
    }
    if (body.mode !== undefined && !isValidMode(body.mode)) {
      return HttpResponse.json({ message: "invalid mode" }, { status: 400 })
    }
    const sessionModel = body.model === undefined ? session.model : normalizeModel(body.model)
    if (!sessionModel) {
      return HttpResponse.json({ message: "invalid model" }, { status: 400 })
    }

    const nextTitle = title ? truncateCharacters(title, 80) : session.title
    const nextMode = body.mode ?? session.mode
    const nextWorktreeId =
      body.worktreeId === undefined ? session.worktreeId : body.worktreeId || undefined
    if (
      nextTitle === session.title &&
      nextMode === session.mode &&
      sessionModel === session.model &&
      nextWorktreeId === session.worktreeId
    ) {
      return HttpResponse.json(sessionRecord(session))
    }

    const updatedSession: Session = {
      ...session,
      title: nextTitle,
      projectSlug: session.projectSlug,
      mode: nextMode,
      model: sessionModel,
      worktreeId: nextWorktreeId,
      status: session.status,
      updatedAt: now(),
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json(sessionRecord(updatedSession))
  }),

  http.patch("/api/sessions/:id/mode", async ({ params, request }) => {
    await delay(120)
    const body = await readJSON<UpdateSessionInput>(request)
    if (body instanceof Response) {
      return body
    }
    const session = runtimeSessions.get(String(params.id))

    if (!session || !body.mode) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    if (!isValidMode(body.mode)) {
      return HttpResponse.json({ message: "invalid mode" }, { status: 400 })
    }
    if (session.mode === body.mode) {
      return HttpResponse.json(sessionRecord(session))
    }

    const updatedSession: Session = {
      ...session,
      mode: body.mode,
      status: session.status,
      updatedAt: now(),
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json(sessionRecord(updatedSession))
  }),

  http.patch("/api/sessions/:id/model", async ({ params, request }) => {
    await delay(120)
    const body = await readJSON<UpdateSessionInput>(request)
    if (body instanceof Response) {
      return body
    }
    const session = runtimeSessions.get(String(params.id))

    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    const sessionModel = normalizeModel(body.model ?? "")
    if (!sessionModel) {
      return HttpResponse.json({ message: "invalid model" }, { status: 400 })
    }
    if (session.model === sessionModel) {
      return HttpResponse.json(sessionRecord(session))
    }

    const updatedSession: Session = {
      ...session,
      model: sessionModel,
      updatedAt: now(),
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json(sessionRecord(updatedSession))
  }),

  http.post("/api/sessions/:id/cancel", async ({ params }) => {
    await delay(160)
    const session = runtimeSessions.get(String(params.id))

    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    const closed = isActiveSession(session)

    const updatedSession: Session = {
      ...session,
      status: "idle",
      updatedAt: now(),
      messages: [
        ...session.messages,
        {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          role: "system",
          content: "Agent canceled\nThe active run was stopped by the user.",
          createdAt: now(),
        },
      ],
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json({ ok: true, closed })
  }),

  http.post("/api/sessions/:id/permissions/:permissionID", async ({ params, request }) => {
    await delay(160)
    const sessionId = String(params.id)
    const permissionID = String(params.permissionID)
    const body = await readJSON<{ decision?: string }>(request)
    if (body instanceof Response) {
      return body
    }

    const match = findPermission(permissionID)
    if (!match || match.permission.sessionId !== sessionId) {
      return HttpResponse.json({ message: "permission request not found" }, { status: 404 })
    }
    const { session, permission } = match
    if (permission.status !== "pending") {
      return HttpResponse.json(
        { message: "permission request already resolved" },
        { status: 409 }
      )
    }
    if (session.status !== "running") {
      return HttpResponse.json(
        { message: "permission request is not attached to an active run" },
        { status: 409 }
      )
    }
    const decision = body.decision?.trim().toLowerCase()
    if (decision !== "allow" && decision !== "deny") {
      return HttpResponse.json(
        { message: "decision must be allow or deny" },
        { status: 400 }
      )
    }

    const status: PermissionStatus = decision === "allow" ? "allowed" : "denied"
    const updatedAt = now()
    const updatedPermission = {
      ...permission,
      status,
      updatedAt,
    }
    const updatedSession: Session = {
      ...session,
      status: "done",
      permissions: session.permissions.map((candidate) =>
        candidate.id === permissionID ? updatedPermission : candidate
      ),
      messages: [
        ...session.messages,
        {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          role: "system",
          content: `Permission ${status}: ${permission.toolName}`,
          createdAt: updatedAt,
        },
      ],
      updatedAt,
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json(updatedPermission)
  }),

  http.post("/api/sessions/:id/messages", async ({ params, request }) => {
    await delay(420)
    const session = runtimeSessions.get(String(params.id))
    const body = await readJSON<SendMessageInput>(request)
    if (body instanceof Response) {
      return body
    }

    const content = body.content?.trim() ?? ""
    if (!content) {
      return HttpResponse.json({ message: "content is required" }, { status: 400 })
    }
    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    if (isActiveSession(session)) {
      return HttpResponse.json(
        { message: "session already has an active run" },
        { status: 409 }
      )
    }

    const createdAt = now()
    const userMessage = {
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      role: "user" as const,
      content,
      createdAt,
    }
    const assistantMessage = {
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      role: "assistant" as const,
      content: session.projectSlug
        ? `I will keep ${session.projectSlug} as the project context for this session. Use any mode to continue from the same task state.`
        : "This demo requires sessions to be created from a project. Start a new session from a folder if context is missing.",
      createdAt: now(),
    }
    const thinkingMessage = {
      id: `msg-${crypto.randomUUID().slice(0, 8)}`,
      role: "system" as const,
      content: "Thinking\nReading the current session context and choosing the next project-aware response.",
      createdAt: now(),
    }
    const updatedSession: Session = {
      ...session,
      messages: [...session.messages, userMessage, thinkingMessage, assistantMessage],
      updatedAt: assistantMessage.createdAt,
    }

    runtimeSessions.set(updatedSession.id, updatedSession)
    return HttpResponse.json([userMessage], { status: 202 })
  }),

  http.post("/api/projects/:slug/git/pull", async ({ params }) => {
    await delay(520)
    const projectSlug = String(params.slug)
    const gitStatus = gitStatuses[projectSlug]

    if (!gitStatus) {
      return HttpResponse.json({ message: "Project not found" }, { status: 404 })
    }

    gitStatus.lastPulledAt = now()
    gitStatus.behind = 0
    gitStatus.pullMessage = `Pulled ${gitStatus.defaultBranch}; local ${gitStatus.branch} is up to date.`

    return HttpResponse.json(gitStatus)
  }),

  http.get("/api/projects/:slug/git/worktrees", async ({ params }) => {
    await delay(140)
    const projectSlug = String(params.slug)
    const project = runtimeProjects.find((candidate) => candidate.slug === projectSlug)

    if (!project) {
      return HttpResponse.json({ message: "Project not found" }, { status: 404 })
    }

    const activeIds = activeWorktreeIds()
    return HttpResponse.json(
      sortWorktreesByStoreOrder(
        runtimeWorktrees
          .filter((worktree) => worktree.projectSlug === projectSlug)
          .map((worktree) => mapWorktree(worktree, activeIds))
      )
    )
  }),

  http.post("/api/projects/:slug/git/worktrees", async ({ params, request }) => {
    await delay(320)
    const projectSlug = String(params.slug)
    const body = await readJSON<CreateWorktreeInput>(request)
    if (body instanceof Response) {
      return body
    }
    const project = runtimeProjects.find((candidate) => candidate.slug === projectSlug)

    if (!project) {
      return HttpResponse.json({ message: "Project not found" }, { status: 404 })
    }
    if (!body.name?.trim() || !body.branch?.trim()) {
      return HttpResponse.json({ message: "name and branch are required" }, { status: 400 })
    }
    if (!isValidWorktreeName(body.name)) {
      return HttpResponse.json(
        { message: "worktree name must be a single directory name" },
        { status: 400 }
      )
    }
    if (/\s/.test(body.branch.trim())) {
      return HttpResponse.json(
        { message: "branch must not contain whitespace" },
        { status: 400 }
      )
    }
    if (!isLikelyBranchName(body.branch.trim())) {
      return HttpResponse.json(
        { message: "branch must be a valid branch name" },
        { status: 400 }
      )
    }

    const worktree: Worktree = {
      id: `wt-${crypto.randomUUID().slice(0, 8)}`,
      projectSlug,
      name: body.name.trim(),
      branch: body.branch.trim(),
      path: `${project.path}-${body.name.trim()}`,
      status: "ready",
      lastUsedAt: now(),
    }

    runtimeWorktrees = [...runtimeWorktrees, worktree]
    return HttpResponse.json(worktree, { status: 201 })
  }),

  http.patch("/api/projects/:slug/git/worktrees/:worktreeId", async ({ params }) => {
    await delay(220)
    const projectSlug = String(params.slug)
    const worktreeId = String(params.worktreeId)
    const worktree = runtimeWorktrees.find(
      (candidate) => candidate.projectSlug === projectSlug && candidate.id === worktreeId
    )

    if (!worktree) {
      return HttpResponse.json({ message: "Worktree not found" }, { status: 404 })
    }

    return HttpResponse.json(mapWorktree(worktree))
  }),

  http.delete("/api/projects/:slug/git/worktrees/:worktreeId", async ({ params }) => {
    await delay(240)
    const projectSlug = String(params.slug)
    const worktreeId = String(params.worktreeId)
    const target = runtimeWorktrees.find(
      (worktree) => worktree.projectSlug === projectSlug && worktree.id === worktreeId
    )

    if (!target) {
      return HttpResponse.json({ message: "Worktree not found" }, { status: 404 })
    }
    if (mapWorktree(target).status === "active") {
      return HttpResponse.json(
        { message: "active worktree cannot be removed" },
        { status: 409 }
      )
    }

    runtimeWorktrees = runtimeWorktrees.filter((worktree) => worktree.id !== worktreeId)
    return HttpResponse.json({ ok: true })
  }),
  http.get("/api/sessions/:id/git/diff", async ({ params }) => {
    await delay(300)
    const session = runtimeSessions.get(String(params.id))
    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    if (!session.worktreeId) {
      return HttpResponse.json({ diff: "", type: "empty" })
    }
    const diff = `diff --git a/README.md b/README.md
index b28b261..78619bc 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Coding Broker
 
-This is a test file.
+This is a test file.
+
+Updated by agent sandbox session!`
    return HttpResponse.json({ diff, type: "uncommitted" })
  }),

  http.post("/api/sessions/:id/git/publish", async ({ params }) => {
    await delay(500)
    const session = runtimeSessions.get(String(params.id))
    if (!session) {
      return HttpResponse.json({ message: "Session not found" }, { status: 404 })
    }
    if (!session.worktreeId) {
      return HttpResponse.json({ message: "No worktree assigned" }, { status: 400 })
    }
    const worktreeIndex = runtimeWorktrees.findIndex((wt) => wt.id === session.worktreeId)
    if (worktreeIndex !== -1) {
      const wt = runtimeWorktrees[worktreeIndex]
      const updatedWt: Worktree = {
        ...wt,
        pushed: true,
        pullRequestUrl: `https://github.com/example/repo/compare/main...${wt.branch}?expand=1`,
        pullRequestNumber: 0,
      }
      runtimeWorktrees[worktreeIndex] = updatedWt
      
      const nextSession = {
        ...session,
        worktree: updatedWt,
      }
      runtimeSessions.set(session.id, nextSession)
      
      return HttpResponse.json(mapWorktree(updatedWt))
    }
    return HttpResponse.json({ message: "Worktree not found" }, { status: 404 })
  }),
]

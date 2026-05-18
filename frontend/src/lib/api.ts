import type {
  AppConfig,
  CreateProjectInput,
  CreateSessionInput,
  DirectoryEntry,
  DirectoryBrowseResult,
  CreateWorktreeInput,
  GitStatus,
  Message,
  PermissionRequest,
  ProjectDetail,
  ProjectRecord,
  SendMessageInput,
  Session,
  SessionMode,
  SessionRecord,
  UpdateSessionInput,
  Worktree,
} from "@/types/domain"

type BackendSessionDetail = {
  session: SessionRecord
  project: ProjectRecord
  messages: Session["messages"] | null
  worktree?: Worktree | null
  permissions?: Session["permissions"] | null
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "ApiError"
  }
}

async function requestJson<ResponseBody>(
  path: string,
  init?: RequestInit
): Promise<ResponseBody> {
  const headers = new Headers(init?.headers)
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json")
  }
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(path, {
    ...init,
    headers,
  })

  if (!response.ok) {
    throw new ApiError(
      (await readErrorMessage(response)) ?? `Request failed: ${response.status}`,
      response.status
    )
  }

  const body = await response.text()
  if (!body) {
    return undefined as ResponseBody
  }

  try {
    return JSON.parse(body) as ResponseBody
  } catch {
    throw new ApiError("Invalid JSON response", response.status)
  }
}

async function readErrorMessage(response: Response) {
  const body = await response.text().catch(() => "")
  const trimmedBody = body.trim()
  if (!trimmedBody) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmedBody) as unknown
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? parsed.message
        : null
    return typeof message === "string" && message.trim() ? message : trimmedBody
  } catch {
    return trimmedBody
  }
}

export const api = {
  config: async () => normalizeAppConfig(await requestJson<Partial<AppConfig>>("/api/config")),
  directories: async (input?: { path?: string; search?: string }) => {
    const params = new URLSearchParams()
    if (input?.path) {
      params.set("path", input.path)
    }
    if (input?.search) {
      params.set("search", input.search)
    }
    const query = params.toString()
    const result = await requestJson<DirectoryBrowseResult>(
      `/api/directories${query ? `?${query}` : ""}`
    )
    return {
      ...result,
      entries: sortDirectoryEntries(normalizeArray(result.entries)),
    }
  },
  projects: async () =>
    sortProjectsByStoreOrder(
      normalizeArray(await requestJson<ProjectDetail[] | null>("/api/projects")).map(
        normalizeProjectDetail
      )
    ),
  createProject: (input: CreateProjectInput) =>
    requestJson<ProjectRecord>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  project: async (projectSlug: string) =>
    normalizeProjectDetail(await requestJson<ProjectDetail>(`/api/projects/${projectSlug}`)),
  sessions: async () =>
    sortSessionsByStoreOrder(
      normalizeArray(await requestJson<SessionRecord[] | null>("/api/sessions"))
    ),
  createSession: (input: CreateSessionInput) =>
    requestJson<SessionRecord>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  session: async (sessionId: string) => {
    const detail = await requestJson<BackendSessionDetail>(
      `/api/sessions/${sessionId}`
    )
    return normalizeSessionDetail(detail)
  },
  deleteSession: (sessionId: string) =>
    requestJson<{ ok: true }>(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    }),
  updateSession: (sessionId: string, input: UpdateSessionInput) =>
    requestJson<SessionRecord>(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateMode: (sessionId: string, mode: SessionMode) =>
    requestJson<SessionRecord>(
      `/api/sessions/${sessionId}/mode`,
      {
        method: "PATCH",
        body: JSON.stringify({ mode }),
      }
    ),
  updateModel: (sessionId: string, model: string) =>
    requestJson<SessionRecord>(
      `/api/sessions/${sessionId}/model`,
      {
        method: "PATCH",
        body: JSON.stringify({ model }),
      }
    ),
  cancelSession: async (sessionId: string) => {
    await requestJson<{ ok: true; closed: boolean }>(
      `/api/sessions/${sessionId}/cancel`,
      { method: "POST" }
    )
    return api.session(sessionId)
  },
  sendMessage: async (sessionId: string, input: SendMessageInput) => {
    await requestJson<Message[]>(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    })
    return api.session(sessionId)
  },
  pullMain: (projectSlug: string) =>
    requestJson<GitStatus>(`/api/projects/${projectSlug}/git/pull`, {
      method: "POST",
    }),
  worktrees: async (projectSlug: string) =>
    sortWorktreesByStoreOrder(
      normalizeArray(
        await requestJson<Worktree[] | null>(`/api/projects/${projectSlug}/git/worktrees`)
      )
    ),
  createWorktree: (projectSlug: string, input: CreateWorktreeInput) =>
    requestJson<Worktree>(`/api/projects/${projectSlug}/git/worktrees`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  switchWorktree: (projectSlug: string, worktreeId: string) =>
    requestJson<Worktree>(
      `/api/projects/${projectSlug}/git/worktrees/${worktreeId}`,
      { method: "PATCH" }
    ),
  deleteWorktree: (projectSlug: string, worktreeId: string) =>
    requestJson<{ ok: true }>(
      `/api/projects/${projectSlug}/git/worktrees/${worktreeId}`,
      { method: "DELETE" }
    ),
  respondPermission: (sessionId: string, permissionId: string, decision: "allow" | "deny") =>
    requestJson<PermissionRequest>(
      `/api/sessions/${sessionId}/permissions/${permissionId}`,
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      }
    ),
  getSessionGitDiff: (sessionId: string) =>
    requestJson<{ diff: string; type: "empty" | "not_created" | "uncommitted" | "commit" }>(
      `/api/sessions/${sessionId}/git/diff`
    ),
  publishSessionGit: (sessionId: string) =>
    requestJson<Worktree>(
      `/api/sessions/${sessionId}/git/publish`,
      {
        method: "POST",
      }
    ),
}

function normalizeAppConfig(config: Partial<AppConfig>): AppConfig {
  const availableModels = normalizeArray(config.availableModels).filter(
    (model): model is string => typeof model === "string" && model.trim() !== ""
  )
  const defaultModel =
    typeof config.defaultModel === "string" && config.defaultModel.trim() !== ""
      ? config.defaultModel
      : availableModels[0] ?? ""

  return {
    defaultModel,
    availableModels,
    workspaceRoot: typeof config.workspaceRoot === "string" ? config.workspaceRoot : "",
    worktreeRoot: typeof config.worktreeRoot === "string" ? config.worktreeRoot : "",
  }
}

function normalizeSessionDetail(detail: BackendSessionDetail): Session {
  const messages = sortCreatedAtThenId(normalizeArray(detail.messages))
  const permissions = sortCreatedAtThenId(normalizeArray(detail.permissions))

  return {
    ...detail.session,
    worktree: detail.worktree ?? undefined,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
    permissions,
    plan: [],
  }
}

function normalizeProjectDetail(project: ProjectDetail): ProjectDetail {
  return {
    ...project,
    createdAt: project.createdAt ?? project.updatedAt,
    worktrees: sortWorktreesByStoreOrder(normalizeArray(project.worktrees)),
  }
}

function sortProjectsByStoreOrder(input: ProjectDetail[]) {
  return [...input].sort((left, right) => {
    const updatedAtComparison = compareDesc(left.updatedAt, right.updatedAt)
    if (updatedAtComparison !== 0) {
      return updatedAtComparison
    }
    return compareDesc(left.slug, right.slug)
  })
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

function sortSessionsByStoreOrder(input: SessionRecord[]) {
  return [...input].sort((left, right) => {
    const updatedAtComparison = compareDesc(left.updatedAt, right.updatedAt)
    if (updatedAtComparison !== 0) {
      return updatedAtComparison
    }
    return compareDesc(left.id, right.id)
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

function sortCreatedAtThenId<T extends { createdAt: string; id: string }>(input: T[]) {
  return [...input].sort((left, right) => {
    const createdAtComparison = compareAsc(left.createdAt, right.createdAt)
    if (createdAtComparison !== 0) {
      return createdAtComparison
    }
    return compareAsc(left.id, right.id)
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

function normalizeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

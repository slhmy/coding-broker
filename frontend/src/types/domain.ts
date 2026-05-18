export type SessionMode = "ask" | "plan" | "act"

export type SessionStatus =
  | "idle"
  | "running"
  | "failed"
  | "done"

export type ProjectHealth = "clean" | "changes" | "behind" | "conflict"

export type MessageRole = "user" | "assistant" | "system"

export type WorktreeStatus = "active" | "ready" | "dirty"

export type PermissionStatus = "pending" | "allowed" | "denied"

export type AppConfig = {
  defaultModel: string
  availableModels: string[]
  workspaceRoot: string
  worktreeRoot: string
}

export type DirectoryEntry = {
  name: string
  path: string
  hidden: boolean
  gitRepository: boolean
  unreadable: boolean
  permissionError?: string
}

export type DirectoryBrowseResult = {
  homePath: string
  currentPath: string
  parentPath: string | null
  entries: DirectoryEntry[]
}

export type ProjectRecord = {
  slug: string
  name: string
  path: string
  defaultBranch: string
  createdAt: string
  updatedAt: string
}

export type Project = {
  slug: string
  name: string
  path: string
  description: string
  branch: string
  defaultBranch: string
  health: ProjectHealth
  createdAt: string
  updatedAt: string
  worktreeCount: number
}

export type GitStatus = {
  projectSlug: string
  branch: string
  defaultBranch: string
  ahead: number
  behind: number
  dirtyFiles: number
  reachable: boolean
  message: string | null
  lastPulledAt: string | null
  pullMessage: string | null
}

export type Worktree = {
  id: string
  projectSlug: string
  name: string
  branch: string
  path: string
  status: WorktreeStatus
  lastUsedAt: string
  commitSha?: string
  pushed?: boolean
  pullRequestUrl?: string
  pullRequestNumber?: number
}

export type PermissionRequest = {
  id: string
  sessionId: string
  requestId: string
  toolName: string
  toolInput: string
  status: PermissionStatus
  createdAt: string
  updatedAt: string
}

export type Message = {
  id: string
  role: MessageRole
  content: string
  createdAt: string
}

export type PlanItem = {
  id: string
  title: string
  detail: string
  status: "done" | "active" | "pending"
}

export type Session = {
  id: string
  title: string
  status: SessionStatus
  mode: SessionMode
  model: string
  projectSlug: string | null
  worktreeId?: string
  worktree?: Worktree
  messages: Message[]
  permissions: PermissionRequest[]
  plan: PlanItem[]
  createdAt: string
  updatedAt: string
}

export type SessionRecord = Omit<Session, "messages" | "permissions" | "plan">

export type SessionSummary = Pick<
  SessionRecord,
  "id" | "title" | "status" | "mode" | "model" | "projectSlug" | "updatedAt"
>

export type ProjectDetail = Project & {
  git: GitStatus
  worktrees: Worktree[]
}

export type CreateSessionInput = {
  projectSlug: string
  prompt?: string
  model?: string
}

export type CreateProjectInput = {
  name?: string
  path: string
  defaultBranch?: string
}

export type UpdateSessionInput = {
  title?: string
  mode?: SessionMode
  model?: string
}

export type SendMessageInput = {
  content: string
}

export type CreateWorktreeInput = {
  name: string
  branch: string
}

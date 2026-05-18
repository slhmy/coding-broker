/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import {
  CaretDownIcon,
  CheckIcon,
  FolderOpenIcon,
  PlusIcon,
  RobotIcon,
  SidebarIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ModeBadge } from "@/components/mode-badge"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DirectoryPicker } from "@/components/projects/directory-picker"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { formatShortDateTime } from "@/lib/datetime"
import {
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  ensureSessionsLoaded,
  useSessionStore,
} from "@/lib/session-store"
import { cn } from "@/lib/utils"
import type { ProjectDetail, SessionStatus } from "@/types/domain"

const SIDEBAR_WIDTH_STORAGE_KEY = "app-shell-sidebar-width"
const SIDEBAR_MIN_WIDTH = 320
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_DEFAULT_WIDTH = 336
const SESSION_DRAG_MIME_TYPE = "application/x-coding-broker-session"
const DRAG_REBASE_DELAY_MS = 3000

type DragMergeStrategy = "merge" | "rebase"

function sessionStatusBorderClassName(status: SessionStatus) {
  switch (status) {
    case "running":
      return "session-status-card-running border-blue-300/35 bg-blue-50/35 dark:border-blue-500/25 dark:bg-blue-950/15"
    case "failed":
      return "border-red-500/85 bg-red-50/45 dark:border-red-500/75 dark:bg-red-950/20"
    case "done":
      return "border-emerald-500/60 bg-emerald-50/30 dark:border-emerald-500/45 dark:bg-emerald-950/10"
    case "idle":
    default:
      return "border-zinc-200/80 dark:border-zinc-800"
  }
}

function SessionRunningEdge() {
  return <span aria-hidden="true" className="session-running-edge" />
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { summaries: sessions } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isOpeningSession, setIsOpeningSession] = React.useState(false)
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] =
    React.useState(false)
  const [isSubmittingWorkspace, setIsSubmittingWorkspace] =
    React.useState(false)
  const [workspaceForm, setWorkspaceForm] = React.useState({
    name: "",
    path: "",
    defaultBranch: "main",
  })
  const [sessionIdPendingDelete, setSessionIdPendingDelete] = React.useState<
    string | null
  >(null)
  const [sessionIdDeleting, setSessionIdDeleting] = React.useState<
    string | null
  >(null)
  const [draggedSessionId, setDraggedSessionId] = React.useState<string | null>(
    null
  )
  const [dropTarget, setDropTarget] = React.useState<{
    sessionId: string
    strategy: DragMergeStrategy
  } | null>(null)
  const [sessionIntegration, setSessionIntegration] = React.useState<{
    sessionId: string
    strategy: DragMergeStrategy
  } | null>(null)
  const rebaseTimerRef = React.useRef<ReturnType<typeof window.setTimeout> | null>(
    null
  )

  const currentSessionId = location.pathname.startsWith("/sessions/")
    ? location.pathname.split("/")[2]
    : null
  const currentSession = currentSessionId
    ? sessions.find((session) => session.id === currentSessionId)
    : null
  const queryParams = new URLSearchParams(location.search)
  const queryProjectSlug =
    queryParams.get("workspace") ?? queryParams.get("project")
  const selectedProjectSlug =
    currentSession?.projectSlug ?? queryProjectSlug ?? projects[0]?.slug ?? null
  const selectedProject =
    projects.find((project) => project.slug === selectedProjectSlug) ?? null
  const visibleSessions = React.useMemo(
    () =>
      selectedProjectSlug
        ? sessions.filter((session) => session.projectSlug === selectedProjectSlug)
        : sessions,
    [selectedProjectSlug, sessions]
  )
  const hasSelectedProjectCurrentSession = Boolean(
    selectedProjectSlug &&
    visibleSessions.some(
      (session) =>
        session.projectSlug === selectedProjectSlug && !session.worktreeId
    )
  )
  const sessionPendingDelete = React.useMemo(
    () =>
      sessions.find((session) => session.id === sessionIdPendingDelete) ?? null,
    [sessionIdPendingDelete, sessions]
  )

  const loadSidebarData = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const [, nextProjects] = await Promise.all([
        ensureSessionsLoaded(),
        api.projects(),
      ])
      setProjects(nextProjects)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const clearRebaseTimer = React.useCallback(() => {
    if (rebaseTimerRef.current) {
      window.clearTimeout(rebaseTimerRef.current)
      rebaseTimerRef.current = null
    }
  }, [])

  const clearDragMergeState = React.useCallback(() => {
    clearRebaseTimer()
    setDraggedSessionId(null)
    setDropTarget(null)
  }, [clearRebaseTimer])

  const setDragMergeTarget = React.useCallback(
    (sessionId: string) => {
      setDropTarget((current) => {
        if (current?.sessionId === sessionId) {
          return current
        }
        clearRebaseTimer()
        rebaseTimerRef.current = window.setTimeout(() => {
          setDropTarget((latest) =>
            latest?.sessionId === sessionId
              ? { sessionId, strategy: "rebase" }
              : latest
          )
          rebaseTimerRef.current = null
        }, DRAG_REBASE_DELAY_MS)
        return { sessionId, strategy: "merge" }
      })
    },
    [clearRebaseTimer]
  )

  React.useEffect(() => clearRebaseTimer, [clearRebaseTimer])

  React.useEffect(() => {
    loadSidebarData().catch((error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to load sidebar"
      )
    })
  }, [loadSidebarData])

  React.useEffect(() => {
    if (!selectedProjectSlug) {
      return
    }
    if (hasSelectedProjectCurrentSession) {
      return
    }
    void createStoredSession({
      projectSlug: selectedProjectSlug,
      useCurrentBranch: true,
    }).catch((error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not initialize current branch session"
      )
    })
  }, [hasSelectedProjectCurrentSession, selectedProjectSlug])

  async function openWorkspaceSession() {
    if (!selectedProjectSlug) {
      toast.info("Select a workspace before starting a session")
      return
    }

    setIsOpeningSession(true)
    try {
      const session = await createStoredSession({
        projectSlug: selectedProjectSlug,
        useCurrentBranch: true,
      })
      onNavigate?.()
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open session"
      )
    } finally {
      setIsOpeningSession(false)
    }
  }

  async function createWorktreeSession() {
    if (!selectedProjectSlug) {
      toast.info("Select a workspace before starting a session")
      return
    }

    setIsOpeningSession(true)
    try {
      const session = await createStoredSession({
        projectSlug: selectedProjectSlug,
        useCurrentBranch: false,
      })
      onNavigate?.()
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create worktree"
      )
    } finally {
      setIsOpeningSession(false)
    }
  }

  function switchWorkspace(projectSlug: string) {
    onNavigate?.()
    navigate(`/workspace?workspace=${encodeURIComponent(projectSlug)}`)
  }

  async function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!workspaceForm.path.trim()) {
      toast.error("Workspace path is required")
      return
    }
    if (/\s/.test(workspaceForm.defaultBranch.trim())) {
      toast.error("Default branch must not contain whitespace")
      return
    }
    if (!isLikelyBranchName(workspaceForm.defaultBranch.trim())) {
      toast.error("Default branch must be a valid branch name")
      return
    }

    setIsSubmittingWorkspace(true)
    try {
      const workspace = await api.createProject({
        name: workspaceForm.name.trim() || undefined,
        path: workspaceForm.path.trim(),
        defaultBranch: workspaceForm.defaultBranch.trim() || undefined,
      })
      const nextProjects = await api.projects()
      setProjects(nextProjects)
      setWorkspaceForm({ name: "", path: "", defaultBranch: "main" })
      setIsWorkspaceDialogOpen(false)
      toast.success(`${workspace.name} added`)
      switchWorkspace(workspace.slug)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add workspace"
      )
    } finally {
      setIsSubmittingWorkspace(false)
    }
  }

  async function deleteSession() {
    if (!sessionPendingDelete) {
      return
    }
    if (
      !sessionPendingDelete.worktreeId ||
      sessionPendingDelete.deletable === false
    ) {
      setSessionIdPendingDelete(null)
      toast.error("Current branch session cannot be deleted")
      return
    }

    const deletedSessionId = sessionPendingDelete.id
    setSessionIdDeleting(deletedSessionId)
    try {
      await deleteStoredSession(deletedSessionId)
      api
        .projects()
        .then(setProjects)
        .catch(() => {
          // The session is already deleted; workspace counts will refresh on the next load.
        })
      setSessionIdPendingDelete(null)
      toast.success("Session deleted")

      if (location.pathname === `/sessions/${deletedSessionId}`) {
        onNavigate?.()
        navigate("/workspace")
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete session"
      )
    } finally {
      setSessionIdDeleting(null)
    }
  }

  async function mergeSessionIntoTarget(
    sourceSessionId: string,
    targetSessionId: string,
    strategy: DragMergeStrategy
  ) {
    if (sourceSessionId === targetSessionId || sessionIntegration) {
      return
    }

    const sourceSession = sessions.find(
      (session) => session.id === sourceSessionId
    )
    const targetSession = sessions.find(
      (session) => session.id === targetSessionId
    )
    if (!sourceSession || !targetSession) {
      toast.error("Session unavailable")
      return
    }

    const sourceProjectSlug = sourceSession.projectSlug
    if (!sourceProjectSlug || sourceSession.worktreeId == null) {
      toast.error("Only worktree sessions can be merged")
      clearDragMergeState()
      return
    }

    const sourceWorktreeId = sourceSession.worktreeId
    setSessionIntegration({ sessionId: targetSessionId, strategy })
    try {
      await api.integrateWorktree(sourceProjectSlug, sourceWorktreeId, {
        strategy,
        targetSessionId,
      })
      toast.success(
        `${strategy === "merge" ? "Merge" : "Rebase"} sent to ${targetSession.title}`
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${strategy}`
      )
    } finally {
      setSessionIntegration(null)
      clearDragMergeState()
    }
  }

  function sessionDragId(event: React.DragEvent) {
    return (
      event.dataTransfer.getData(SESSION_DRAG_MIME_TYPE) ||
      event.dataTransfer.getData("text/plain")
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:gap-4 sm:p-4 md:p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">Coding Broker</div>
          <div className="truncate text-xs text-muted-foreground">
            Workspace
          </div>
        </div>
        <ThemeToggle />
      </div>

      <WorkspaceSwitcher
        projects={projects}
        selectedProject={selectedProject}
        isLoading={isLoading}
        onSwitch={switchWorkspace}
        onAdd={() => setIsWorkspaceDialogOpen(true)}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground">
            Sessions
          </span>
          <div className="grid w-full grid-cols-2 gap-1 min-[360px]:flex min-[360px]:w-auto min-[360px]:min-w-0 min-[360px]:grid-cols-none min-[360px]:items-center">
            <Button
              variant="ghost"
              size="xs"
              className="w-full min-[360px]:w-auto"
              onClick={openWorkspaceSession}
              disabled={isOpeningSession}
            >
              <FolderOpenIcon data-icon="inline-start" />
              Current
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="w-full min-[360px]:w-auto"
              onClick={createWorktreeSession}
              disabled={isOpeningSession}
            >
              <PlusIcon data-icon="inline-start" />
              Worktree
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 pr-2">
            {isLoading ? (
              <>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </>
            ) : visibleSessions.length > 0 ? (
              visibleSessions.map((session) => (
                <NavLink
                  key={session.id}
                  to={`/sessions/${session.id}`}
                  draggable={sessionIdDeleting !== session.id}
                  onDragStart={(event) => {
                    setDraggedSessionId(session.id)
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData(
                      SESSION_DRAG_MIME_TYPE,
                      session.id
                    )
                    event.dataTransfer.setData("text/plain", session.id)
                  }}
                  onDragEnd={() => {
                    clearDragMergeState()
                  }}
                  onDragOver={(event) => {
                    const sourceSessionId =
                      draggedSessionId || sessionDragId(event)
                    if (!sourceSessionId || sourceSessionId === session.id) {
                      return
                    }
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "move"
                    setDragMergeTarget(session.id)
                  }}
                  onDragLeave={() => {
                    setDropTarget((current) => {
                      if (current?.sessionId !== session.id) {
                        return current
                      }
                      clearRebaseTimer()
                      return null
                    })
                  }}
                  onDrop={(event) => {
                    const sourceSessionId =
                      draggedSessionId || sessionDragId(event)
                    if (!sourceSessionId || sourceSessionId === session.id) {
                      setDropTarget(null)
                      return
                    }
                    event.preventDefault()
                    event.stopPropagation()
                    const strategy =
                      dropTarget?.sessionId === session.id
                        ? dropTarget.strategy
                        : "merge"
                    void mergeSessionIntoTarget(
                      sourceSessionId,
                      session.id,
                      strategy
                    )
                  }}
                  onClick={onNavigate}
                  aria-disabled={sessionIntegration?.sessionId === session.id}
                  className={({ isActive }) =>
                    cn(
                      "relative flex min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-2.5 text-sm transition-colors hover:bg-muted/70",
                      sessionStatusBorderClassName(session.status),
                      isActive && "bg-muted",
                      draggedSessionId === session.id && "opacity-60",
                      dropTarget?.sessionId === session.id &&
                        draggedSessionId !== session.id &&
                        (dropTarget.strategy === "rebase"
                          ? "border-violet-500/70 bg-violet-50/50 ring-2 ring-violet-500/60 ring-offset-2 ring-offset-background dark:bg-violet-950/20"
                          : "border-sky-500/70 bg-sky-50/50 ring-2 ring-sky-500/60 ring-offset-2 ring-offset-background dark:bg-sky-950/20"),
                      sessionIntegration?.sessionId === session.id &&
                        "pointer-events-none"
                    )
                  }
                >
                  {session.status === "running" ? <SessionRunningEdge /> : null}
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium">
                        {session.title}
                      </div>
                    </div>
                    {session.worktreeId && session.deletable !== false ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="-mt-1 -mr-1 size-7 shrink-0"
                        disabled={sessionIdDeleting === session.id}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setSessionIdPendingDelete(session.id)
                        }}
                      >
                        <TrashIcon />
                        <span className="sr-only">Delete session</span>
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden text-xs text-muted-foreground">
                    <span className="shrink-0">{session.worktreeId ? "Worktree" : "Current"}</span>
                    <span aria-hidden="true" className="shrink-0">/</span>
                    <ModeBadge mode={session.mode} className="shrink-0" />
                    <span className="ml-auto shrink-0 text-right">
                      {sessionIntegration?.sessionId === session.id
                        ? sessionIntegration.strategy === "rebase"
                          ? "Rebasing"
                          : "Merging"
                        : dropTarget?.sessionId === session.id
                          ? dropTarget.strategy === "rebase"
                            ? "Drop to rebase"
                            : "Drop to merge"
                          : formatShortDateTime(session.updatedAt)}
                    </span>
                  </div>
                </NavLink>
              ))
            ) : (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-center">
                <RobotIcon />
                <div className="text-xs font-medium">No sessions yet</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Start from a workspace to keep context locked.
                </p>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={openWorkspaceSession}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Current
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      <Dialog
        open={sessionPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSessionIdPendingDelete(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              Delete this session, its messages, permissions, and worktree
              records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              onClick={deleteSession}
              disabled={
                sessionPendingDelete
                  ? sessionIdDeleting === sessionPendingDelete.id
                  : false
              }
            >
              <TrashIcon data-icon="inline-start" />
              {sessionPendingDelete &&
              sessionIdDeleting === sessionPendingDelete.id
                ? "Deleting"
                : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={isWorkspaceDialogOpen}
        onOpenChange={setIsWorkspaceDialogOpen}
      >
        <DialogContent className="max-h-[calc(100svh-1.5rem)] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={createWorkspace} className="contents">
            <DialogHeader>
              <DialogTitle>Add workspace</DialogTitle>
              <DialogDescription>
                Register an existing Git work tree so sessions can use it as
                context.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Input
                aria-label="Workspace display name"
                value={workspaceForm.name}
                onChange={(event) =>
                  setWorkspaceForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Display name"
              />
              <DirectoryPicker
                value={workspaceForm.path}
                onValueChange={(path) =>
                  setWorkspaceForm((current) => ({ ...current, path }))
                }
                disabled={isSubmittingWorkspace}
              />
              <Input
                aria-label="Default branch"
                value={workspaceForm.defaultBranch}
                onChange={(event) =>
                  setWorkspaceForm((current) => ({
                    ...current,
                    defaultBranch: event.target.value,
                  }))
                }
                placeholder="main"
              />
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={isSubmittingWorkspace || !workspaceForm.path.trim()}
              >
                <PlusIcon data-icon="inline-start" />
                {isSubmittingWorkspace ? "Adding" : "Add workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function WorkspaceSwitcher({
  projects,
  selectedProject,
  isLoading,
  onSwitch,
  onAdd,
}: {
  projects: ProjectDetail[]
  selectedProject: ProjectDetail | null
  isLoading: boolean
  onSwitch: (projectSlug: string) => void
  onAdd: () => void
}) {
  const [isOpen, setIsOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredProjects = React.useMemo(() => {
    if (!normalizedQuery) {
      return projects
    }

    return projects.filter((project) =>
      [
        project.name,
        project.path,
        project.branch,
        project.defaultBranch,
        project.health,
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [normalizedQuery, projects])

  React.useEffect(() => {
    if (!isOpen) {
      setQuery("")
      setActiveIndex(0)
      return
    }

    window.setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [isOpen])

  React.useEffect(() => {
    setActiveIndex(0)
  }, [normalizedQuery])

  React.useEffect(() => {
    if (activeIndex > filteredProjects.length - 1) {
      setActiveIndex(Math.max(filteredProjects.length - 1, 0))
    }
  }, [activeIndex, filteredProjects.length])

  function selectProject(project: ProjectDetail) {
    setIsOpen(false)
    setQuery("")
    onSwitch(project.slug)
  }

  function addWorkspace() {
    setIsOpen(false)
    setQuery("")
    onAdd()
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) =>
        filteredProjects.length === 0
          ? 0
          : Math.min(current + 1, filteredProjects.length - 1)
      )
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      const project = filteredProjects[activeIndex]
      if (project) {
        selectProject(project)
      }
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <div>
        <Button
          variant="outline"
          className="h-auto w-full justify-between gap-2 px-3 py-2.5 text-left"
          disabled={isLoading}
          onClick={() => setIsOpen(true)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpenIcon data-icon="inline-start" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {isLoading
                  ? "Loading workspaces"
                  : selectedProject?.name ?? "Select workspace"}
              </div>
              {selectedProject ? (
                <div className="truncate text-xs text-muted-foreground">
                  {selectedProject.path}
                </div>
              ) : null}
            </div>
          </div>
          <CaretDownIcon />
        </Button>
      </div>
      <DialogContent className="max-h-[calc(100svh-1.5rem)] gap-3 p-0 sm:max-w-xl">
        <DialogHeader className="px-4 pt-4 pr-12">
          <DialogTitle>Open workspace</DialogTitle>
          <DialogDescription>
            Search by name, path, branch, or health.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex min-h-0 flex-col gap-3 px-4 pb-4"
          onKeyDown={handleListKeyDown}
        >
          <Input
            ref={searchInputRef}
            aria-label="Search workspaces"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces"
          />
          <ScrollArea className="max-h-[min(52svh,24rem)] rounded-lg border">
            <div className="flex flex-col p-1">
              {filteredProjects.length > 0 ? (
                filteredProjects.map((project, index) => {
                  const isSelected = selectedProject?.slug === project.slug
                  const branch = project.branch || project.defaultBranch

                  return (
                    <button
                      key={project.slug}
                      type="button"
                      className={cn(
                        "flex min-w-0 flex-col gap-2 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        index === activeIndex && "bg-muted",
                        isSelected && "bg-muted/70"
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectProject(project)}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {project.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {project.path}
                          </div>
                        </div>
                        {isSelected ? (
                          <CheckIcon className="mt-0.5 shrink-0" />
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="max-w-full">
                          <span className="min-w-0 truncate">{branch}</span>
                        </Badge>
                        <Badge variant="outline">
                          {project.worktreeCount} worktree
                          {project.worktreeCount === 1 ? "" : "s"}
                        </Badge>
                        <Badge variant="outline">{project.health}</Badge>
                      </div>
                    </button>
                  )
                })
              ) : (
                <div className="flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center">
                  <FolderOpenIcon />
                  <div className="text-sm font-medium">
                    {projects.length === 0
                      ? "No workspaces"
                      : "No matching workspaces"}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Add an existing Git work tree to start working from it.
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
          <Button variant="outline" className="w-full" onClick={addWorkspace}>
            <PlusIcon data-icon="inline-start" />
            Add workspace
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AppShell() {
  const [isMobileOpen, setIsMobileOpen] = React.useState(false)
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    const parsedWidth = Number(storedWidth)

    if (Number.isFinite(parsedWidth)) {
      return clampSidebarWidth(
        parsedWidth,
        typeof window === "undefined" ? undefined : window.innerWidth
      )
    }

    return SIDEBAR_DEFAULT_WIDTH
  })
  const [isResizingSidebar, setIsResizingSidebar] = React.useState(false)
  const sidebarDragState = React.useRef({
    startX: 0,
    startWidth: SIDEBAR_DEFAULT_WIDTH,
  })

  React.useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  React.useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current, window.innerWidth))
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  React.useEffect(() => {
    if (!isResizingSidebar) {
      return undefined
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - sidebarDragState.current.startX
      setSidebarWidth(
        clampSidebarWidth(
          sidebarDragState.current.startWidth + delta,
          window.innerWidth
        )
      )
    }

    const handlePointerUp = () => {
      setIsResizingSidebar(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp, { once: true })
    window.addEventListener("pointercancel", handlePointerUp, { once: true })

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("pointercancel", handlePointerUp)
    }
  }, [isResizingSidebar])

  React.useEffect(() => {
    if (!isResizingSidebar) {
      return undefined
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isResizingSidebar])

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    sidebarDragState.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    }
    setIsResizingSidebar(true)
  }

  return (
    <div className="flex h-svh min-w-0 overflow-hidden bg-background text-foreground">
      <aside
        className="hidden shrink-0 border-r bg-sidebar text-sidebar-foreground lg:flex"
        style={{ width: sidebarWidth }}
      >
        <div className="min-w-0 flex-1">
          <SidebarContent />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className={cn(
            "hidden w-1.5 shrink-0 cursor-col-resize touch-none border-l border-sidebar-border/60 bg-transparent transition-colors md:block",
            "hover:bg-sidebar-accent/70",
            isResizingSidebar ? "bg-sidebar-accent" : undefined
          )}
          onPointerDown={startSidebarResize}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3 lg:hidden">
          <Sheet open={isMobileOpen} onOpenChange={setIsMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-sm">
                <SidebarIcon />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[min(88vw,22rem)] p-0"
              showCloseButton={false}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarContent onNavigate={() => setIsMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </header>

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function isLikelyBranchName(value: string) {
  return (
    value === "" ||
    (!value.includes("..") && !value.startsWith("/") && !value.endsWith("/"))
  )
}

function clampSidebarWidth(width: number, viewportWidth?: number) {
  const maxWidth = viewportWidth
    ? Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 360)
    : SIDEBAR_MAX_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, maxWidth))
}

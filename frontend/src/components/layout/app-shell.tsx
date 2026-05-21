/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import {
  CaretDownIcon,
  CheckIcon,
  FolderOpenIcon,
  ListIcon,
  PlusIcon,
  RobotIcon,
  SidebarIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { StatusBadge } from "@/components/status-badge"
import { ThemeToggle } from "@/components/theme-toggle"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import type { ProjectDetail } from "@/types/domain"

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { summaries: sessions } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isCreating, setIsCreating] = React.useState(false)
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] = React.useState(false)
  const [isSubmittingWorkspace, setIsSubmittingWorkspace] = React.useState(false)
  const [workspaceForm, setWorkspaceForm] = React.useState({
    name: "",
    path: "",
    defaultBranch: "main",
  })
  const [sessionIdPendingDelete, setSessionIdPendingDelete] = React.useState<string | null>(null)
  const [sessionIdDeleting, setSessionIdDeleting] = React.useState<string | null>(null)

  const currentSessionId = location.pathname.startsWith("/sessions/")
    ? location.pathname.split("/")[2]
    : null
  const currentSession = currentSessionId
    ? sessions.find((session) => session.id === currentSessionId)
    : null
  const queryParams = new URLSearchParams(location.search)
  const queryProjectSlug = queryParams.get("workspace") ?? queryParams.get("project")
  const selectedProjectSlug = currentSession?.projectSlug ?? queryProjectSlug ?? projects[0]?.slug ?? null
  const selectedProject = projects.find((project) => project.slug === selectedProjectSlug) ?? null

  const sessionPendingDelete = React.useMemo(
    () => sessions.find((session) => session.id === sessionIdPendingDelete) ?? null,
    [sessionIdPendingDelete, sessions]
  )

  const loadSidebarData = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const [, nextProjects] = await Promise.all([ensureSessionsLoaded(), api.projects()])
      setProjects(nextProjects)
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadSidebarData().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Failed to load sidebar")
    })
  }, [loadSidebarData])

  async function createSession(useCurrentBranch: boolean) {
    if (!selectedProjectSlug) {
      toast.info("Select a workspace before starting a session")
      return
    }

    setIsCreating(true)
    try {
      const session = await createStoredSession({
        projectSlug: selectedProjectSlug,
        useCurrentBranch,
      })
      onNavigate?.()
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create session")
    } finally {
      setIsCreating(false)
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
      toast.error(error instanceof Error ? error.message : "Could not add workspace")
    } finally {
      setIsSubmittingWorkspace(false)
    }
  }

  async function deleteSession() {
    if (!sessionPendingDelete) {
      return
    }

    const deletedSessionId = sessionPendingDelete.id
    setSessionIdDeleting(deletedSessionId)
    try {
      await deleteStoredSession(deletedSessionId)
      api.projects()
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
      toast.error(error instanceof Error ? error.message : "Could not delete session")
    } finally {
      setSessionIdDeleting(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">Coding Broker</div>
          <div className="truncate text-xs text-muted-foreground">Workspace</div>
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
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground">Sessions</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => createSession(true)}
              disabled={isCreating}
            >
              <PlusIcon data-icon="inline-start" />
              New
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => createSession(false)}
              disabled={isCreating}
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
            ) : sessions.length > 0 ? (
              sessions.map((session) => {
                const project = projects.find(
                  (candidate) => candidate.slug === session.projectSlug
                )

                return (
                  <NavLink
                    key={session.id}
                    to={`/sessions/${session.id}`}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "flex min-w-0 flex-col gap-1 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted",
                        isActive && "bg-muted"
                      )
                    }
                  >
                    <div className="truncate font-medium">{session.title}</div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{project?.name ?? "Missing workspace"}</span>
                      <span aria-hidden="true">/</span>
                      <span>{session.mode}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge value={session.status} />
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="truncate text-xs text-muted-foreground">
                          {formatShortDateTime(session.updatedAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 shrink-0"
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
                      </div>
                    </div>
                  </NavLink>
                )
              })
            ) : (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-center">
                <RobotIcon />
                <div className="text-xs font-medium">No sessions yet</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Start from a workspace to keep context locked.
                </p>
                <Button variant="outline" size="xs" onClick={() => createSession(true)}>
                  <PlusIcon data-icon="inline-start" />
                  New
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
              Delete this session, its messages, permissions, and worktree records.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              onClick={deleteSession}
              disabled={sessionPendingDelete ? sessionIdDeleting === sessionPendingDelete.id : false}
            >
              <TrashIcon data-icon="inline-start" />
              {sessionPendingDelete && sessionIdDeleting === sessionPendingDelete.id ? "Deleting" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={isWorkspaceDialogOpen} onOpenChange={setIsWorkspaceDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <form onSubmit={createWorkspace} className="contents">
            <DialogHeader>
              <DialogTitle>Add workspace</DialogTitle>
              <DialogDescription>
                Register an existing Git work tree so sessions can use it as context.
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-auto w-full justify-between gap-2 px-3 py-2 text-left"
          disabled={isLoading}
        >
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpenIcon data-icon="inline-start" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {selectedProject?.name ?? "Select workspace"}
              </div>
            </div>
          </div>
          <CaretDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuGroup>
          {projects.length > 0 ? (
            projects.map((project) => (
              <DropdownMenuItem
                key={project.slug}
                onSelect={() => onSwitch(project.slug)}
                className="min-h-10"
              >
                <FolderOpenIcon data-icon="inline-start" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{project.name}</div>
                </div>
                {selectedProject?.slug === project.slug ? <CheckIcon /> : null}
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAdd}>
          <PlusIcon data-icon="inline-start" />
          Add workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell() {
  const [isMobileOpen, setIsMobileOpen] = React.useState(false)

  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground md:block">
        <SidebarContent />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between gap-3 border-b px-3 md:hidden">
          <Sheet open={isMobileOpen} onOpenChange={setIsMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-sm">
                <SidebarIcon />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[88vw] p-0" showCloseButton={false}>
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <SidebarContent onNavigate={() => setIsMobileOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 items-center gap-2">
            <ListIcon />
            <span className="truncate text-sm font-medium">Workspace</span>
          </div>
          <ThemeToggle />
        </header>

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function isLikelyBranchName(value: string) {
  return value === "" || (!value.includes("..") && !value.startsWith("/") && !value.endsWith("/"))
}

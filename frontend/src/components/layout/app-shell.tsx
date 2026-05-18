/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import {
  FolderIcon,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  deleteSession as deleteStoredSession,
  ensureSessionsLoaded,
  useSessionStore,
} from "@/lib/session-store"
import { cn } from "@/lib/utils"
import type { ProjectDetail } from "@/types/domain"

function ShellNavigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 text-sm">
      <NavLink
        to="/agents"
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            isActive && "bg-muted text-foreground"
          )
        }
      >
        <RobotIcon data-icon="inline-start" />
        Agents
      </NavLink>
      <NavLink
        to="/projects"
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            isActive && "bg-muted text-foreground"
          )
        }
      >
        <FolderIcon data-icon="inline-start" />
        Folders
      </NavLink>
    </nav>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { summaries: sessions } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isCreating, setIsCreating] = React.useState(false)
  const [sessionIdPendingDelete, setSessionIdPendingDelete] = React.useState<string | null>(null)
  const [sessionIdDeleting, setSessionIdDeleting] = React.useState<string | null>(null)

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

  async function createSession() {
    setIsCreating(true)
    onNavigate?.()
    navigate("/agents")
    setIsCreating(false)
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
          // The session is already deleted; project counts will refresh on the next load.
        })
      setSessionIdPendingDelete(null)
      toast.success("Session deleted")

      if (location.pathname === `/sessions/${deletedSessionId}`) {
        onNavigate?.()
        navigate("/agents")
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
          <div className="truncate text-xs text-muted-foreground">Agents workspace</div>
        </div>
        <Button size="icon-sm" onClick={createSession} disabled={isCreating}>
          <PlusIcon />
          <span className="sr-only">New session</span>
        </Button>
        <ThemeToggle />
      </div>

      <ShellNavigation onNavigate={onNavigate} />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground">Sessions</span>
          <Button variant="ghost" size="xs" onClick={createSession} disabled={isCreating}>
            <PlusIcon data-icon="inline-start" />
            New
          </Button>
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
                      <span className="truncate">{project?.name ?? "Missing project"}</span>
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
                  Start from a project to keep context locked.
                </p>
                <Button variant="outline" size="xs" onClick={createSession}>
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
    </div>
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
            <span className="truncate text-sm font-medium">Agent workspace</span>
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

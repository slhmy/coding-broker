/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { GearIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react"

import { GitPanel } from "@/components/git/git-panel"
import { ProjectSelector } from "@/components/projects/project-selector"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { useSessionStore } from "@/lib/session-store"
import type { ProjectDetail, SessionSummary } from "@/types/domain"

export function WorkspacePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [workspaces, setWorkspaces] = React.useState<ProjectDetail[]>([])
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = React.useState<
    string | null
  >(null)
  const [workspaceSessions, setWorkspaceSessions] = React.useState<
    SessionSummary[]
  >([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] =
    React.useState(false)
  const [isManageWorkspaceDialogOpen, setIsManageWorkspaceDialogOpen] =
    React.useState(false)
  const [isSubmittingWorkspace, setIsSubmittingWorkspace] =
    React.useState(false)
  const [workspaceDeletingSlug, setWorkspaceDeletingSlug] = React.useState<
    string | null
  >(null)
  const [workspaceDeleteCandidate, setWorkspaceDeleteCandidate] =
    React.useState<ProjectDetail | null>(null)
  const [workspaceForm, setWorkspaceForm] = React.useState({
    name: "",
    path: "",
    defaultBranch: "main",
  })
  const { summaries: sessions } = useSessionStore()

  const selectedWorkspace = React.useMemo(
    () =>
      workspaces.find(
        (workspace) => workspace.slug === selectedWorkspaceSlug
      ) ?? null,
    [workspaces, selectedWorkspaceSlug]
  )
  const currentWorktreeId = React.useMemo(
    () =>
      sessions.find(
        (session) =>
          session.projectSlug === selectedWorkspace?.slug && session.worktreeId
      )?.worktreeId,
    [selectedWorkspace?.slug, sessions]
  )

  const applyWorkspaces = React.useCallback(
    (nextWorkspaces: ProjectDetail[]) => {
      setWorkspaces(nextWorkspaces)
      setSelectedWorkspaceSlug((current) => {
        const queryWorkspaceSlug =
          searchParams.get("workspace") ?? searchParams.get("project")

        if (
          queryWorkspaceSlug &&
          nextWorkspaces.some(
            (workspace) => workspace.slug === queryWorkspaceSlug
          )
        ) {
          return queryWorkspaceSlug
        }
        if (
          current &&
          nextWorkspaces.some((workspace) => workspace.slug === current)
        ) {
          return current
        }
        return nextWorkspaces[0]?.slug ?? null
      })
    },
    [searchParams]
  )

  const loadWorkspaces = React.useCallback(async () => {
    setIsLoading(true)
    try {
      applyWorkspaces(await api.projects())
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load workspace"
      )
    } finally {
      setIsLoading(false)
    }
  }, [applyWorkspaces])

  React.useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  React.useEffect(() => {
    if (!selectedWorkspaceSlug) {
      setWorkspaceSessions([])
      return
    }

    let isCancelled = false
    api
      .sessions({ projectSlug: selectedWorkspaceSlug })
      .then((records) => {
        if (!isCancelled) {
          setWorkspaceSessions(records)
        }
      })
      .catch((error: unknown) => {
        if (!isCancelled) {
          toast.error(
            error instanceof Error ? error.message : "Failed to load sessions"
          )
          setWorkspaceSessions(
            sessions.filter(
              (session) => session.projectSlug === selectedWorkspaceSlug
            )
          )
        }
      })

    return () => {
      isCancelled = true
    }
  }, [selectedWorkspaceSlug, sessions])

  React.useEffect(() => {
    const queryWorkspaceSlug =
      searchParams.get("workspace") ?? searchParams.get("project")

    if (!queryWorkspaceSlug) {
      return
    }
    if (
      !workspaces.some((workspace) => workspace.slug === queryWorkspaceSlug)
    ) {
      return
    }

    setSelectedWorkspaceSlug(queryWorkspaceSlug)
  }, [searchParams, workspaces])

  function handleWorkspaceChange(nextWorkspace: ProjectDetail) {
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.slug === nextWorkspace.slug ? nextWorkspace : workspace
      )
    )
    setSelectedWorkspaceSlug(nextWorkspace.slug)
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

    setIsSubmittingWorkspace(true)
    try {
      const workspace = await api.createProject({
        name: workspaceForm.name.trim() || undefined,
        path: workspaceForm.path.trim(),
        defaultBranch: workspaceForm.defaultBranch.trim() || undefined,
      })
      applyWorkspaces(await api.projects())
      setWorkspaceForm({ name: "", path: "", defaultBranch: "main" })
      setIsWorkspaceDialogOpen(false)
      toast.success(`${workspace.name} added`)
      navigate(`/workspace?workspace=${encodeURIComponent(workspace.slug)}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add workspace"
      )
    } finally {
      setIsSubmittingWorkspace(false)
    }
  }

  async function deleteWorkspace(project: ProjectDetail) {
    setWorkspaceDeletingSlug(project.slug)
    try {
      await api.deleteProject(project.slug)
      const nextWorkspaces = await api.projects()
      applyWorkspaces(nextWorkspaces)
      setWorkspaceDeleteCandidate(null)
      toast.success(`${project.name} removed`)
      if (selectedWorkspaceSlug === project.slug) {
        const nextSlug = nextWorkspaces[0]?.slug
        navigate(nextSlug ? `/workspace?workspace=${encodeURIComponent(nextSlug)}` : "/workspace")
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove workspace"
      )
    } finally {
      setWorkspaceDeletingSlug(null)
    }
  }

  const recentSessions = React.useMemo(
    () => workspaceSessions.slice(0, 6),
    [workspaceSessions]
  )

  return (
    <div className="subtle-scrollbar h-full overflow-auto">
      <div className="content-shell flex min-h-full flex-col gap-4">
        <header className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-normal">
              Workspace
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Pick a workspace, open a session, or jump back into recent work.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <ProjectSelector
              projects={workspaces}
              value={selectedWorkspace?.slug ?? null}
              disabled={isLoading}
              onValueChange={(projectSlug) => {
                setSelectedWorkspaceSlug(projectSlug)
                navigate(
                  `/workspace?workspace=${encodeURIComponent(projectSlug)}`
                )
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setIsWorkspaceDialogOpen(true)}
                disabled={isSubmittingWorkspace}
              >
                <PlusIcon data-icon="inline-start" />
                Add Workspace
              </Button>
              <Button
                variant="outline"
                onClick={() => setIsManageWorkspaceDialogOpen(true)}
                disabled={workspaces.length === 0}
              >
                <GearIcon data-icon="inline-start" />
                Manage
              </Button>
            </div>
          </div>
        </header>
        {isLoading ? (
          <Skeleton className="min-h-96 w-full flex-1 rounded-lg" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Recent sessions</CardTitle>
                  <CardDescription>
                    Most recent sessions for the selected workspace.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {recentSessions.length > 0 ? (
                    recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => navigate(`/sessions/${session.id}`)}
                      >
                        <span className="min-w-0 truncate">{session.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {session.status}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      No recent sessions yet.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
            {selectedWorkspace ? (
              <GitPanel
                project={selectedWorkspace}
                onProjectChange={handleWorkspaceChange}
                currentWorktreeId={currentWorktreeId}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>No workspace selected</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Select a workspace to see Git state and worktrees.
                </CardContent>
              </Card>
            )}
          </div>
        )}
        <Dialog
          open={isWorkspaceDialogOpen}
          onOpenChange={setIsWorkspaceDialogOpen}
        >
          <DialogContent className="sm:max-w-md">
            <form onSubmit={createWorkspace} className="contents">
              <DialogHeader>
                <DialogTitle>Add workspace</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Input
                  aria-label="Workspace name"
                  placeholder="Name"
                  value={workspaceForm.name}
                  onChange={(event) =>
                    setWorkspaceForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <Input
                  aria-label="Workspace path"
                  placeholder="Path"
                  value={workspaceForm.path}
                  onChange={(event) =>
                    setWorkspaceForm((current) => ({
                      ...current,
                      path: event.target.value,
                    }))
                  }
                />
                <Input
                  aria-label="Default branch"
                  placeholder="Default branch"
                  value={workspaceForm.defaultBranch}
                  onChange={(event) =>
                    setWorkspaceForm((current) => ({
                      ...current,
                      defaultBranch: event.target.value,
                    }))
                  }
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmittingWorkspace}
                  onClick={() => setIsWorkspaceDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmittingWorkspace || !workspaceForm.path.trim()}
                >
                  {isSubmittingWorkspace ? "Adding" : "Add workspace"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog
          open={isManageWorkspaceDialogOpen}
          onOpenChange={(open) => {
            setIsManageWorkspaceDialogOpen(open)
            if (!open) {
              setWorkspaceDeleteCandidate(null)
            }
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Manage workspaces</DialogTitle>
            </DialogHeader>
            <div className="flex max-h-[min(60svh,28rem)] flex-col gap-2 overflow-y-auto">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.slug}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {workspace.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {workspace.path}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={workspaceDeletingSlug === workspace.slug}
                    onClick={() => setWorkspaceDeleteCandidate(workspace)}
                    title="Remove workspace"
                  >
                    <TrashIcon />
                    <span className="sr-only">Remove workspace</span>
                  </Button>
                </div>
              ))}
            </div>
            {workspaceDeleteCandidate ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <div className="font-medium">
                  Remove {workspaceDeleteCandidate.name}?
                </div>
                <p className="mt-1 text-xs leading-relaxed">
                  This removes the workspace registration and related sessions
                  from Coding Broker. It does not delete the project directory.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      workspaceDeletingSlug === workspaceDeleteCandidate.slug
                    }
                    onClick={() => setWorkspaceDeleteCandidate(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={
                      workspaceDeletingSlug === workspaceDeleteCandidate.slug
                    }
                    onClick={() => deleteWorkspace(workspaceDeleteCandidate)}
                  >
                    {workspaceDeletingSlug === workspaceDeleteCandidate.slug
                      ? "Removing"
                      : "Remove"}
                  </Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

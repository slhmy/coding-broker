import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
  GitMergeIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { ApiError, api } from "@/lib/api"
import type { ProjectDetail, Worktree } from "@/types/domain"

type GitPanelProps = {
  project: ProjectDetail | null
  onProjectChange: (project: ProjectDetail) => void
  currentWorktreeId?: string
}

export function GitPanel({
  project,
  onProjectChange,
  currentWorktreeId,
}: GitPanelProps) {
  const navigate = useNavigate()
  const [worktreePendingDelete, setWorktreePendingDelete] =
    React.useState<Worktree | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [busyWorktreeAction, setBusyWorktreeAction] = React.useState<
    string | null
  >(null)

  async function refreshProject(projectSlug: string) {
    const nextProject = await api.project(projectSlug)
    onProjectChange(nextProject)
  }

  async function refreshProjectBestEffort(projectSlug: string) {
    await refreshProject(projectSlug).catch(() => {
      // Explicit user actions surface the original request error.
    })
  }

  async function openWorktree(worktree: Worktree) {
    if (!project) {
      return
    }

    try {
      const loadedWorktree = await api.switchWorktree(project.slug, worktree.id)
      await refreshProject(project.slug)
      if (loadedWorktree.sessionId) {
        navigate(`/sessions/${loadedWorktree.sessionId}`)
      } else {
        const session = await api.createSession({
          projectSlug: project.slug,
          worktreeId: worktree.id,
        })
        navigate(`/sessions/${session.id}`)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await refreshProjectBestEffort(project.slug)
        toast.error("Worktree no longer exists")
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not load worktree"
      )
    }
  }

  async function runWorktreeAction(
    worktree: Worktree,
    action: "pull" | "push" | "merge" | "rebase"
  ) {
    if (!project) {
      return
    }

    setBusyWorktreeAction(`${worktree.id}:${action}`)
    try {
      if (action === "pull") {
        await api.pullWorktree(project.slug, worktree.id)
        toast.success("Worktree pulled")
      } else if (action === "push") {
        await api.pushWorktree(project.slug, worktree.id)
        toast.success("Worktree pushed")
      } else {
        const result = await api.integrateWorktree(project.slug, worktree.id, {
          strategy: action,
        })
        toast.success(`${action === "merge" ? "Merge" : "Rebase"} prompt sent`)
        navigate(`/sessions/${result.session.id}`)
      }
      await refreshProject(project.slug)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await refreshProjectBestEffort(project.slug)
        toast.error("Worktree no longer exists")
        return
      }
      toast.error(
        error instanceof Error ? error.message : `Could not ${action} worktree`
      )
    } finally {
      setBusyWorktreeAction(null)
    }
  }

  async function deleteWorktree() {
    if (!project || !worktreePendingDelete) {
      return
    }

    setIsDeleting(true)
    try {
      await api.deleteWorktree(project.slug, worktreePendingDelete.id)
      setWorktreePendingDelete(null)
      await refreshProject(project.slug)
      toast.success("Worktree removed")
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setWorktreePendingDelete(null)
        await refreshProjectBestEffort(project.slug)
        toast.error("Worktree no longer exists")
        return
      }
      if (error instanceof ApiError && error.status === 409) {
        setWorktreePendingDelete(null)
        await refreshProjectBestEffort(project.slug)
        toast.error(error.message)
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not remove worktree"
      )
    } finally {
      setIsDeleting(false)
    }
  }

  if (!project) {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <GitBranchIcon />
        <div className="text-sm font-medium">
          Select a workspace for Git actions
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Branch status and worktree controls become available when this session
          has a target workspace.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 rounded-lg border bg-card p-3 text-card-foreground shadow-sm sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <GitBranchIcon data-icon="inline-start" />
            <span className="truncate">{project.name}</span>
          </div>
        </div>
        <StatusBadge value={project.health} />
      </div>

      <div className="grid grid-cols-3 gap-1.5 text-center text-xs sm:gap-2">
        <div className="rounded-lg bg-muted/70 p-2 sm:p-3">
          <div className="text-sm font-semibold">{project.git.ahead}</div>
          <div className="text-muted-foreground">ahead</div>
        </div>
        <div className="rounded-lg bg-muted/70 p-2 sm:p-3">
          <div className="text-sm font-semibold">{project.git.behind}</div>
          <div className="text-muted-foreground">behind</div>
        </div>
        <div className="rounded-lg bg-muted/70 p-2 sm:p-3">
          <div className="text-sm font-semibold">{project.git.dirtyFiles}</div>
          <div className="text-muted-foreground">dirty</div>
        </div>
      </div>

      {project.git.message ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          {project.git.message}
        </div>
      ) : null}

      <Separator />

      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Project worktrees</div>
          <div className="text-xs text-muted-foreground">
            {project.worktrees.length} total
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {project.worktrees.map((worktree) => (
            <div
              key={worktree.id}
              className={
                worktree.id === currentWorktreeId
                  ? "rounded-lg border border-primary/40 bg-primary/5 p-3"
                  : "rounded-lg border p-3"
              }
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {worktree.name}
                    {worktree.id === currentWorktreeId
                      ? " · Current session"
                      : ""}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {worktree.branch}
                  </div>
                </div>
                <StatusBadge value={worktree.status} />
              </div>
              <div className="mt-3 flex flex-col gap-2 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <span className="min-w-0 truncate rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                  {worktree.path}
                </span>
                <div className="grid min-w-0 grid-cols-3 gap-1 min-[420px]:flex min-[420px]:flex-wrap min-[420px]:items-center sm:justify-end">
                  <Button
                    variant="outline"
                    size="xs"
                    className="col-span-3 min-w-0 min-[420px]:col-span-1"
                    onClick={() => openWorktree(worktree)}
                  >
                    Open session
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busyWorktreeAction !== null}
                    title="Pull worktree branch"
                    onClick={() => runWorktreeAction(worktree, "pull")}
                  >
                    <ArrowDownIcon data-icon="inline-start" />
                    <span className="sr-only">Pull worktree</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busyWorktreeAction !== null}
                    title="Push worktree branch"
                    onClick={() => runWorktreeAction(worktree, "push")}
                  >
                    <ArrowUpIcon data-icon="inline-start" />
                    <span className="sr-only">Push worktree</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busyWorktreeAction !== null}
                    title="Send merge prompt to workspace session"
                    onClick={() => runWorktreeAction(worktree, "merge")}
                  >
                    <GitMergeIcon data-icon="inline-start" />
                    <span className="sr-only">Merge worktree</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busyWorktreeAction !== null}
                    title="Send rebase prompt to workspace session"
                    onClick={() => runWorktreeAction(worktree, "rebase")}
                  >
                    Rebase
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={
                      worktree.status === "active" ||
                      worktree.id === currentWorktreeId
                    }
                    title={
                      worktree.status === "active" ||
                      worktree.id === currentWorktreeId
                        ? "Current worktree cannot be deleted"
                        : "Delete worktree"
                    }
                    onClick={() => setWorktreePendingDelete(worktree)}
                  >
                    <TrashIcon data-icon="inline-start" />
                    <span className="sr-only">Delete worktree</span>
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Dialog
        open={worktreePendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setWorktreePendingDelete(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete worktree</DialogTitle>
            <DialogDescription>
              Remove {worktreePendingDelete?.name ?? "this worktree"} from the
              workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={() => setWorktreePendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={deleteWorktree}
            >
              {isDeleting ? "Deleting" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

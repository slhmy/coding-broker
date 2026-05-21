import * as React from "react"
import {
  GitBranchIcon,
  GitPullRequestIcon,
  TrashIcon,
} from "@phosphor-icons/react"
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
}

export function GitPanel({ project, onProjectChange }: GitPanelProps) {
  const [isPulling, setIsPulling] = React.useState(false)
  const [worktreePendingDelete, setWorktreePendingDelete] = React.useState<Worktree | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  async function refreshProject(projectSlug: string) {
    const nextProject = await api.project(projectSlug)
    onProjectChange(nextProject)
  }

  async function refreshProjectBestEffort(projectSlug: string) {
    await refreshProject(projectSlug).catch(() => {
      // Explicit user actions surface the original request error.
    })
  }

  async function pullMain() {
    if (!project) {
      return
    }

    setIsPulling(true)
    try {
      await api.pullMain(project.slug)
      await refreshProject(project.slug)
      toast.success("Main branch pulled")
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("Workspace no longer exists")
        return
      }
      toast.error(error instanceof Error ? error.message : "Pull failed")
    } finally {
      setIsPulling(false)
    }
  }

  async function switchWorktree(worktreeId: string) {
    if (!project) {
      return
    }

    try {
      await api.switchWorktree(project.slug, worktreeId)
      await refreshProject(project.slug)
      toast.success("Worktree loaded")
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await refreshProjectBestEffort(project.slug)
        toast.error("Worktree no longer exists")
        return
      }
      toast.error(error instanceof Error ? error.message : "Could not load worktree")
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
      toast.error(error instanceof Error ? error.message : "Could not remove worktree")
    } finally {
      setIsDeleting(false)
    }
  }

  if (!project) {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
        <GitBranchIcon />
        <div className="text-sm font-medium">Select a workspace for Git actions</div>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Pull, branch, and worktree controls become available when this session has a target workspace.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <GitBranchIcon data-icon="inline-start" />
            <span className="truncate">{project.name}</span>
          </div>
        </div>
        <StatusBadge value={project.health} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-muted p-2">
          <div className="font-medium">{project.git.ahead}</div>
          <div className="text-muted-foreground">ahead</div>
        </div>
        <div className="rounded-lg bg-muted p-2">
          <div className="font-medium">{project.git.behind}</div>
          <div className="text-muted-foreground">behind</div>
        </div>
        <div className="rounded-lg bg-muted p-2">
          <div className="font-medium">{project.git.dirtyFiles}</div>
          <div className="text-muted-foreground">dirty</div>
        </div>
      </div>

      {project.git.message ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          {project.git.message}
        </div>
      ) : null}

      <Button onClick={pullMain} disabled={isPulling || !project.git.reachable}>
        <GitPullRequestIcon data-icon="inline-start" />
        {isPulling ? "Pulling" : `Pull ${project.git.defaultBranch}`}
      </Button>
      {project.git.pullMessage ? (
        <div className="text-xs leading-relaxed text-muted-foreground">{project.git.pullMessage}</div>
      ) : null}

      <Separator />

      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Worktrees</div>
        <div className="flex flex-col gap-2">
          {project.worktrees.map((worktree) => (
            <div key={worktree.id} className="rounded-lg border p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{worktree.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{worktree.branch}</div>
                </div>
                <StatusBadge value={worktree.status} />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{worktree.path}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => switchWorktree(worktree.id)}
                  >
                    Inspect
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={worktree.status === "active"}
                    title={worktree.status === "active" ? "Active worktrees cannot be deleted" : "Delete worktree"}
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
              Remove {worktreePendingDelete?.name ?? "this worktree"} from the workspace.
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

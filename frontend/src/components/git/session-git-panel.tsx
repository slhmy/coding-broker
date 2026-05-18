import * as React from "react"
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  GitBranchIcon,
  GitPullRequestIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import type { ProjectDetail, Session } from "@/types/domain"

type SessionGitPanelProps = {
  session: Session
  project?: ProjectDetail | null
  onProjectChange?: (project: ProjectDetail) => void
}

export function SessionGitPanel({
  session,
  project,
  onProjectChange,
}: SessionGitPanelProps) {
  const [busyAction, setBusyAction] = React.useState<
    "pull" | "push" | "refresh" | null
  >(null)

  const worktree = session.worktree
  const isWorktreeSession = Boolean(session.worktreeId && worktree)
  const gitStatus = isWorktreeSession ? worktree?.git : project?.git
  const branchLabel = worktree?.branch ?? project?.branch ?? "Current branch"
  const branchDescription = isWorktreeSession
    ? (worktree?.name ?? "Session worktree")
    : project
      ? `${project.name} · ${project.git.defaultBranch}`
      : "Project branch"
  const syncMessage =
    gitStatus?.pullMessage ?? gitStatus?.pushMessage ?? gitStatus?.message
  const isReachable = gitStatus?.reachable ?? true

  const refreshProject = React.useCallback(async () => {
    if (!session.projectSlug || !onProjectChange) {
      return
    }
    const nextProject = await api.project(session.projectSlug)
    onProjectChange(nextProject)
  }, [onProjectChange, session.projectSlug])

  async function runSyncAction(action: "pull" | "push") {
    if (!session.projectSlug) {
      return
    }

    setBusyAction(action)
    try {
      if (isWorktreeSession && worktree) {
        if (action === "pull") {
          await api.pullWorktree(session.projectSlug, worktree.id)
          toast.success("Worktree pulled")
        } else {
          await api.pushWorktree(session.projectSlug, worktree.id)
          toast.success("Worktree pushed")
        }
      } else if (action === "pull") {
        await api.pullMain(session.projectSlug)
        toast.success("Current branch pulled")
      } else {
        await api.pushMain(session.projectSlug)
        toast.success("Current branch pushed")
      }

      await refreshProject()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${action} branch`
      )
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRefresh() {
    setBusyAction("refresh")
    try {
      await refreshProject()
      toast.success("Branch details refreshed")
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not refresh branch details"
      )
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="shrink-0 text-primary" />
          <div className="min-w-0">
            <span className="block truncate text-xs font-semibold text-foreground">
              {branchLabel}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {branchDescription}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleRefresh}
          disabled={busyAction !== null}
          title="Refresh branch details"
        >
          <ArrowClockwiseIcon
            className={busyAction === "refresh" ? "animate-spin" : ""}
          />
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-muted/70 p-2">
          <div className="font-semibold">{gitStatus?.ahead ?? 0}</div>
          <div className="text-muted-foreground">ahead</div>
        </div>
        <div className="rounded-lg bg-muted/70 p-2">
          <div className="font-semibold">{gitStatus?.behind ?? 0}</div>
          <div className="text-muted-foreground">behind</div>
        </div>
        <div className="rounded-lg bg-muted/70 p-2">
          <div className="font-semibold">{gitStatus?.dirtyFiles ?? 0}</div>
          <div className="text-muted-foreground">dirty</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="xs"
          className="w-full"
          onClick={() => runSyncAction("pull")}
          disabled={busyAction !== null || !isReachable}
        >
          <ArrowDownIcon data-icon="inline-start" />
          Pull
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="w-full"
          onClick={() => runSyncAction("push")}
          disabled={busyAction !== null || !isReachable}
        >
          <ArrowUpIcon data-icon="inline-start" />
          Push
        </Button>
      </div>

      {!isWorktreeSession ? (
        <div className="rounded-lg border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
          This session follows the current workspace branch instead of a
          dedicated worktree.
        </div>
      ) : null}

      {!isReachable ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive">
          Remote is not reachable for this branch.
        </div>
      ) : null}

      {syncMessage ? (
        <div className="rounded-lg border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
          {syncMessage}
        </div>
      ) : null}

      {worktree?.pullRequestUrl ? (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
          <div className="flex items-start gap-2">
            <CheckCircleIcon className="mt-0.5 shrink-0 text-emerald-500" />
            <div className="min-w-0 flex-1 text-xs">
              <span className="block font-semibold text-emerald-800 dark:text-emerald-300">
                Branch Published
              </span>
              <span className="mt-0.5 block text-[11px] text-emerald-600 dark:text-emerald-400">
                Your sandbox branch has been pushed upstream.
              </span>
              <a
                href={worktree.pullRequestUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <GitPullRequestIcon />
                Open Pull Request
                <ArrowSquareOutIcon />
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

import * as React from "react"
import {
  GitBranchIcon,
  GitPullRequestIcon,
  ArrowSquareOutIcon,
  ArrowClockwiseIcon,
  CheckCircleIcon,
  FileCodeIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import type { Session } from "@/types/domain"

type SessionGitPanelProps = {
  session: Session
  onSessionChange?: (session: Session) => void
}

export function SessionGitPanel({ session, onSessionChange }: SessionGitPanelProps) {
  const [diffData, setDiffData] = React.useState<{ diff: string; type: string } | null>(null)
  const [isLoadingDiff, setIsLoadingDiff] = React.useState(false)
  const [isPublishing, setIsPublishing] = React.useState(false)
  const [showDiff, setShowDiff] = React.useState(true)

  const worktree = session.worktree

  const loadDiff = React.useCallback(async () => {
    if (!worktree) return
    setIsLoadingDiff(true)
    try {
      const data = await api.getSessionGitDiff(session.id)
      setDiffData(data)
    } catch (err) {
      console.error("Failed to load diff", err)
    } finally {
      setIsLoadingDiff(false)
    }
  }, [session.id, worktree])

  React.useEffect(() => {
    if (worktree) {
      loadDiff()
    } else {
      setDiffData(null)
    }
  }, [worktree, loadDiff, session.status])

  if (!worktree) {
    return (
      <div className="rounded-lg border bg-card p-4 text-card-foreground text-center">
        <GitBranchIcon className="mx-auto mb-2 text-muted-foreground" size={24} />
        <div className="text-sm font-medium">No active session workspace</div>
        <p className="mt-1 text-xs text-muted-foreground">
          This session is not bound to a workspace.
        </p>
      </div>
    )
  }

  async function handlePublish() {
    setIsPublishing(true)
    try {
      await api.publishSessionGit(session.id)
      toast.success("Changes pushed and PR comparison page generated!")
      
      // Fetch latest session state to update parent
      if (onSessionChange) {
        const nextSession = await api.session(session.id)
        onSessionChange(nextSession)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to publish branch")
    } finally {
      setIsPublishing(false)
    }
  }

  const renderDiffLine = (line: string, idx: number) => {
    let className = "px-2 py-0.5 font-mono text-[11px] block whitespace-pre-wrap leading-relaxed "
    if (line.startsWith("+") && !line.startsWith("+++")) {
      className += "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-l-2 border-emerald-500"
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      className += "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-l-2 border-rose-500"
    } else if (line.startsWith("@@")) {
      className += "text-blue-500 bg-blue-500/5 font-bold"
    } else if (line.startsWith("diff") || line.startsWith("index")) {
      className += "text-muted-foreground font-semibold border-b border-muted/50 bg-muted/20"
    } else {
      className += "text-foreground/80"
    }

    return (
      <span key={idx} className={className}>
        {line}
      </span>
    )
  }

  const codeDiffLines = diffData?.diff ? diffData.diff.split("\n") : []
  const hasChanges = codeDiffLines.length > 0 && diffData?.type !== "empty"

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="text-primary" size={18} />
          <div className="min-w-0">
            <span className="block truncate text-xs font-semibold text-foreground">
              {worktree.branch}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {worktree.name}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={loadDiff}
            disabled={isLoadingDiff}
            title="Refresh changes"
          >
            <ArrowClockwiseIcon className={isLoadingDiff ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {worktree.pullRequestUrl ? (
        <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-2.5">
          <div className="flex items-start gap-2">
            <CheckCircleIcon className="text-emerald-500 shrink-0 mt-0.5" size={16} />
            <div className="min-w-0 text-xs flex-1">
              <span className="font-semibold text-emerald-800 dark:text-emerald-300 block">
                Branch Published
              </span>
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400 block mt-0.5">
                Your sandbox branch has been pushed upstream.
              </span>
              <a
                href={worktree.pullRequestUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline"
              >
                <GitPullRequestIcon size={14} />
                Open Pull Request
                <ArrowSquareOutIcon size={12} />
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            onClick={handlePublish}
            disabled={isPublishing || (!hasChanges && !worktree.commitSha)}
            className="w-full text-xs font-medium"
          >
            <GitPullRequestIcon className="mr-1.5" size={14} />
            {isPublishing ? "Publishing..." : "Publish PR"}
          </Button>
          {!hasChanges && !worktree.commitSha && (
            <p className="text-[10px] text-center text-muted-foreground">
              No changes generated to publish yet.
            </p>
          )}
        </div>
      )}

      {hasChanges && (
        <div className="mt-1 border-t pt-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <FileCodeIcon size={14} />
              Workspace Changes {diffData?.type === "uncommitted" ? "(uncommitted)" : ""}
            </span>
            <Button
              variant="link"
              size="xs"
              className="text-[10px] h-auto p-0"
              onClick={() => setShowDiff(!showDiff)}
            >
              {showDiff ? "Hide" : "Show"}
            </Button>
          </div>

          {showDiff && (
            <div className="max-h-60 overflow-y-auto rounded border bg-muted/35 select-text">
              <div className="flex flex-col">
                {codeDiffLines.map((line, idx) => renderDiffLine(line, idx))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

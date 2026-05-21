/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { GitPanel } from "@/components/git/git-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import type { ProjectDetail } from "@/types/domain"

export function WorkspacePage() {
  const [searchParams] = useSearchParams()
  const [workspaces, setWorkspaces] = React.useState<ProjectDetail[]>([])
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const selectedWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.slug === selectedWorkspaceSlug) ?? null,
    [workspaces, selectedWorkspaceSlug]
  )

  const applyWorkspaces = React.useCallback((nextWorkspaces: ProjectDetail[]) => {
    setWorkspaces(nextWorkspaces)
    setSelectedWorkspaceSlug((current) => {
      const queryWorkspaceSlug = searchParams.get("workspace") ?? searchParams.get("project")

      if (
        queryWorkspaceSlug &&
        nextWorkspaces.some((workspace) => workspace.slug === queryWorkspaceSlug)
      ) {
        return queryWorkspaceSlug
      }
      if (current && nextWorkspaces.some((workspace) => workspace.slug === current)) {
        return current
      }
      return nextWorkspaces[0]?.slug ?? null
    })
  }, [searchParams])

  const loadWorkspaces = React.useCallback(async () => {
    setIsLoading(true)
    try {
      applyWorkspaces(await api.projects())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load workspace")
    } finally {
      setIsLoading(false)
    }
  }, [applyWorkspaces])

  React.useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  React.useEffect(() => {
    const queryWorkspaceSlug = searchParams.get("workspace") ?? searchParams.get("project")

    if (!queryWorkspaceSlug) {
      return
    }
    if (!workspaces.some((workspace) => workspace.slug === queryWorkspaceSlug)) {
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

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 lg:p-6">
        <h1 className="text-base font-medium">Git context</h1>
        {isLoading ? (
          <Skeleton className="min-h-96 w-full" />
        ) : (
          <GitPanel project={selectedWorkspace} onProjectChange={handleWorkspaceChange} />
        )}
      </div>
    </div>
  )
}

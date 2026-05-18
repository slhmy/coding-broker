/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import { ArrowLeftIcon, RobotIcon } from "@phosphor-icons/react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { GitPanel } from "@/components/git/git-panel"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { formatProjectDateTime } from "@/lib/datetime"
import { createSession } from "@/lib/session-store"
import type { ProjectDetail } from "@/types/domain"

export function ProjectPage() {
  const { projectSlug } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!projectSlug) {
      return
    }

    setIsLoading(true)
    api
      .project(projectSlug)
      .then((nextProject) => {
        setProject(nextProject)
        setErrorMessage(null)
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Project not found")
      })
      .finally(() => setIsLoading(false))
  }, [projectSlug])

  async function startSession() {
    if (!project) {
      return
    }

    try {
      const session = await createSession({ projectSlug: project.slug })
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start session")
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (errorMessage || !project) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Project unavailable</CardTitle>
            <CardDescription>{errorMessage ?? "The selected project was not found."}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/projects">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to projects
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 lg:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" asChild className="mb-2">
              <Link to="/projects">
                <ArrowLeftIcon data-icon="inline-start" />
                Projects
              </Link>
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-medium">{project.name}</h1>
              <StatusBadge value={project.health} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{project.path}</p>
          </div>
          <Button onClick={startSession}>
            <RobotIcon data-icon="inline-start" />
            Start session
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Project context</CardTitle>
              <CardDescription>{project.description}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-lg bg-muted p-3">
                <div className="text-sm font-medium">{project.branch}</div>
                <div className="text-xs text-muted-foreground">current branch</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-sm font-medium">{project.defaultBranch}</div>
                <div className="text-xs text-muted-foreground">mainline</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-sm font-medium">{project.worktrees.length}</div>
                <div className="text-xs text-muted-foreground">worktrees</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-sm font-medium">{formatProjectDateTime(project.createdAt)}</div>
                <div className="text-xs text-muted-foreground">created</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-sm font-medium">{formatProjectDateTime(project.updatedAt)}</div>
                <div className="text-xs text-muted-foreground">updated</div>
              </div>
            </CardContent>
          </Card>
          <GitPanel project={project} onProjectChange={setProject} />
        </div>
      </div>
    </div>
  )
}

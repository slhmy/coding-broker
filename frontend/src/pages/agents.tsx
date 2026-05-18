/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import { ArrowRightIcon, FolderOpenIcon, RobotIcon, TrashIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ModelSelect } from "@/components/model-select"
import { ProjectSelector } from "@/components/projects/project-selector"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { formatShortDateTime } from "@/lib/datetime"
import {
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  ensureSessionsLoaded,
  refreshSessions,
  useSessionStore,
} from "@/lib/session-store"
import type { AppConfig, ProjectDetail } from "@/types/domain"

export function AgentsPage() {
  const navigate = useNavigate()
  const { summaries: sessions } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [appConfig, setAppConfig] = React.useState<AppConfig | null>(null)
  const [selectedProjectSlug, setSelectedProjectSlug] = React.useState<string | null>(null)
  const [selectedModel, setSelectedModel] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(true)
  const [isCreating, setIsCreating] = React.useState(false)
  const [sessionIdPendingDelete, setSessionIdPendingDelete] = React.useState<string | null>(null)
  const [sessionIdDeleting, setSessionIdDeleting] = React.useState<string | null>(null)

  const sessionPendingDelete = React.useMemo(
    () => sessions.find((session) => session.id === sessionIdPendingDelete) ?? null,
    [sessionIdPendingDelete, sessions]
  )

  const loadData = React.useCallback(async () => {
    setIsLoading(true)
    const [, nextProjects, nextConfig] = await Promise.all([
      ensureSessionsLoaded(),
      api.projects(),
      api.config(),
    ])
    setProjects(nextProjects)
    setAppConfig(nextConfig)
    setSelectedModel((current) => current || nextConfig.defaultModel)
    setIsLoading(false)
  }, [])

  React.useEffect(() => {
    loadData().catch((error: unknown) => {
      setIsLoading(false)
      toast.error(error instanceof Error ? error.message : "Failed to load agents")
    })
  }, [loadData])

  async function createSession(projectSlug = selectedProjectSlug) {
    if (!projectSlug) {
      toast.info("Select a folder before starting a session")
      return
    }

    setIsCreating(true)
    try {
      const session = await createStoredSession({
        projectSlug,
        model: selectedModel || appConfig?.defaultModel,
      })
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create session")
    } finally {
      setIsCreating(false)
    }
  }

  async function deleteSession() {
    if (!sessionPendingDelete) {
      return
    }

    setSessionIdDeleting(sessionPendingDelete.id)
    try {
      await deleteStoredSession(sessionPendingDelete.id)
      api.projects()
        .then(setProjects)
        .catch(() => {
          // The session is already deleted; project counts will refresh on the next load.
        })
      setSessionIdPendingDelete(null)
      toast.success("Session deleted")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete session")
    } finally {
      setSessionIdDeleting(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 lg:p-6">
        <section className="flex min-h-[42svh] items-center justify-center py-6">
          <div className="flex w-full max-w-3xl flex-col gap-4">
            <div className="flex flex-col gap-2 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-muted">
                <RobotIcon />
              </div>
              <h1 className="text-xl font-medium">Start an agent session</h1>
              <p className="text-sm text-muted-foreground">
                Describe the task, attach a project context, then switch between Ask, Plan, and Act inside the session.
              </p>
            </div>

            <Card>
              <CardContent className="flex flex-col gap-3 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <ProjectSelector
                      projects={projects}
                      value={selectedProjectSlug}
                      onValueChange={setSelectedProjectSlug}
                      disabled={isLoading}
                    />
                    <ModelSelect
                      models={appConfig?.availableModels ?? []}
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                      disabled={isLoading}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" asChild>
                      <Link to="/projects">
                        <FolderOpenIcon data-icon="inline-start" />
                        Folders
                      </Link>
                    </Button>
                    <Button onClick={() => createSession()} disabled={isCreating || !selectedProjectSlug}>
                      <ArrowRightIcon data-icon="inline-start" />
                      Start
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {appConfig ? (
              <div className="grid gap-2 text-left sm:grid-cols-2">
                <ConfigValue label="Workspace" value={appConfig.workspaceRoot} />
                <ConfigValue label="Worktrees" value={appConfig.worktreeRoot} />
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">Recent sessions</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsLoading(true)
                Promise.all([refreshSessions(), api.projects(), api.config()])
                  .then(([, nextProjects, nextConfig]) => {
                    setProjects(nextProjects)
                    setAppConfig(nextConfig)
                    setSelectedModel((current) => current || nextConfig.defaultModel)
                  })
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : "Failed to refresh agents")
                  })
                  .finally(() => setIsLoading(false))
              }}
              disabled={isLoading}
            >
              Refresh
            </Button>
          </div>
          <div className="grid gap-2">
            {isLoading ? (
              <>
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </>
            ) : sessions.length > 0 ? (
              sessions.map((session) => {
                const project = projects.find(
                  (candidate) => candidate.slug === session.projectSlug
                )

                return (
                  <Link key={session.id} to={`/sessions/${session.id}`}>
                    <Card className="transition-colors hover:bg-muted/50">
                      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{session.title}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{project?.name ?? "Missing project"}</span>
                            <span>{session.model}</span>
                            <span>{session.mode}</span>
                            <span>{formatShortDateTime(session.updatedAt)}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
                          <StatusBadge value={session.status} />
                          <Button
                            variant="ghost"
                            size="icon-sm"
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
                      </CardContent>
                    </Card>
                  </Link>
                )
              })
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <RobotIcon />
                  <div className="text-sm font-medium">No sessions yet</div>
                  <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                    Select a folder, describe the task, then start the first agent thread.
                  </p>
                  <Button
                    onClick={() => createSession()}
                    disabled={isCreating || !selectedProjectSlug}
                  >
                    <ArrowRightIcon data-icon="inline-start" />
                    Start
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </section>
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

function ConfigValue({ label, value }: { label: string; value: string }) {
  const displayValue = value || "Not configured"

  return (
    <div className="min-w-0 rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium" title={displayValue}>
        {displayValue}
      </div>
    </div>
  )
}

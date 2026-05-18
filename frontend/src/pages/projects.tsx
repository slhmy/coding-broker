import * as React from "react"
import { FolderOpenIcon, PlusIcon, RobotIcon } from "@phosphor-icons/react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { StatusBadge } from "@/components/status-badge"
import { DirectoryPicker } from "@/components/projects/directory-picker"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { formatProjectDateTime } from "@/lib/datetime"
import { createSession } from "@/lib/session-store"
import type { ProjectDetail } from "@/types/domain"

export function ProjectsPage() {
  const navigate = useNavigate()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [isDialogOpen, setIsDialogOpen] = React.useState(false)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [form, setForm] = React.useState({
    name: "",
    path: "",
    defaultBranch: "main",
  })

  const refreshProjects = React.useCallback(async () => {
    setIsLoading(true)
    try {
      setProjects(await api.projects())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load projects")
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    api
      .projects()
      .then(setProjects)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Failed to load projects")
      })
      .finally(() => setIsLoading(false))
  }, [])

  async function startSession(projectSlug: string) {
    try {
      const session = await createSession({ projectSlug })
      navigate(`/sessions/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start session")
    }
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!form.path.trim()) {
      toast.error("Project path is required")
      return
    }
    if (/\s/.test(form.defaultBranch.trim())) {
      toast.error("Default branch must not contain whitespace")
      return
    }
    if (!isLikelyBranchName(form.defaultBranch.trim())) {
      toast.error("Default branch must be a valid branch name")
      return
    }

    setIsSubmitting(true)
    try {
      const project = await api.createProject({
        name: form.name.trim() || undefined,
        path: form.path.trim(),
        defaultBranch: form.defaultBranch.trim() || undefined,
      })
      setForm({ name: "", path: "", defaultBranch: "main" })
      setIsDialogOpen(false)
      await refreshProjects()
      toast.success(`${project.name} added`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add project")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 lg:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-medium">Projects</h1>
            <p className="text-sm text-muted-foreground">
              Local Git folders available as targets for agent sessions.
            </p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <PlusIcon data-icon="inline-start" />
                Add project
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <form onSubmit={createProject} className="contents">
                <DialogHeader>
                  <DialogTitle>Add local project</DialogTitle>
                  <DialogDescription>
                    Register an existing Git work tree so sessions can use it as context.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
	                  <Input
	                    aria-label="Project display name"
	                    value={form.name}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Display name"
                  />
                  <DirectoryPicker
                    value={form.path}
                    onValueChange={(path) => setForm((current) => ({ ...current, path }))}
                    disabled={isSubmitting}
                  />
	                  <Input
	                    aria-label="Default branch"
	                    value={form.defaultBranch}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        defaultBranch: event.target.value,
                      }))
                    }
                    placeholder="main"
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={isSubmitting || !form.path.trim()}>
                    <PlusIcon data-icon="inline-start" />
                    {isSubmitting ? "Adding" : "Add project"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {isLoading ? (
            <>
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </>
          ) : projects.length > 0 ? (
            projects.map((project) => (
              <Card key={project.slug}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <FolderOpenIcon data-icon="inline-start" />
                        <span className="truncate">{project.name}</span>
                      </CardTitle>
                      <CardDescription className="truncate">{project.path}</CardDescription>
                    </div>
                    <StatusBadge value={project.health} />
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="text-sm text-muted-foreground">{project.description}</p>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded-lg bg-muted p-2">
                      <div className="font-medium">{project.branch}</div>
                      <div className="text-muted-foreground">branch</div>
                    </div>
                    <div className="rounded-lg bg-muted p-2">
                      <div className="font-medium">{project.worktreeCount}</div>
                      <div className="text-muted-foreground">worktrees</div>
                    </div>
                    <div className="rounded-lg bg-muted p-2">
                      <div className="font-medium">{project.defaultBranch}</div>
                      <div className="text-muted-foreground">default</div>
                    </div>
                    <div className="rounded-lg bg-muted p-2">
                      <div className="font-medium">{formatProjectDateTime(project.updatedAt)}</div>
                      <div className="text-muted-foreground">updated</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" asChild>
                      <Link to={`/projects/${project.slug}`}>Inspect</Link>
                    </Button>
                    <Button onClick={() => startSession(project.slug)}>
                      <RobotIcon data-icon="inline-start" />
                      Start session
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>No projects yet</CardTitle>
                <CardDescription>
                  Add an existing local Git folder before starting an agent session.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setIsDialogOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  Add project
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function isLikelyBranchName(value: string) {
  return value === "" || (!value.includes("..") && !value.startsWith("/") && !value.endsWith("/"))
}

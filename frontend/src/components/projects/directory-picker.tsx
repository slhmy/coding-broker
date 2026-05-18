import * as React from "react"
import {
  ArrowUpIcon,
  CaretRightIcon,
  CheckIcon,
  FolderIcon,
  GitBranchIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { DirectoryBrowseResult } from "@/types/domain"

type DirectoryPickerProps = {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}

function breadcrumbItems(data: DirectoryBrowseResult | null) {
  if (!data) {
    return []
  }
  if (data.currentPath === data.homePath) {
    return [{ label: "Home", path: data.homePath }]
  }

  const separator = data.homePath.includes("\\") ? "\\" : "/"
  const relativePath = data.currentPath
    .slice(data.homePath.length)
    .replace(/^[\\/]+/, "")
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)

  const items = [{ label: "Home", path: data.homePath }]
  let nextPath = data.homePath
  for (const segment of segments) {
    nextPath = `${nextPath}${separator}${segment}`
    items.push({ label: segment, path: nextPath })
  }
  return items
}

function basename(path: string) {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? path
}

export function DirectoryPicker({
  value,
  onValueChange,
  disabled,
}: DirectoryPickerProps) {
  const [browsePath, setBrowsePath] = React.useState<string | undefined>()
  const [search, setSearch] = React.useState("")
  const [data, setData] = React.useState<DirectoryBrowseResult | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  React.useEffect(() => {
    let canceled = false
    const timeout = window.setTimeout(() => {
      setIsLoading(true)
      api
        .directories({ path: browsePath, search })
        .then((result) => {
          if (!canceled) {
            setData(result)
          }
        })
        .catch((error: unknown) => {
          if (!canceled) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to load directories"
            )
          }
        })
        .finally(() => {
          if (!canceled) {
            setIsLoading(false)
          }
        })
    }, 120)

    return () => {
      canceled = true
      window.clearTimeout(timeout)
    }
  }, [browsePath, search])

  const crumbs = breadcrumbItems(data)
  const selectedPath = value.trim()
  const selectedEntry = data?.entries.find((entry) => entry.path === selectedPath)
  const selectedLabel = selectedPath ? basename(selectedPath) : "No folder selected"
  const canUseCurrentDirectory =
    Boolean(data) && selectedPath !== data?.currentPath && !disabled

  function openDirectory(path: string) {
    setSearch("")
    setBrowsePath(path)
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 rounded-lg border bg-muted/20 p-2">
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          aria-label="Workspace path"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="/Users/me/Workspace/project"
          disabled={disabled}
          aria-invalid={!value.trim() ? undefined : false}
        />
        <Button
          type="button"
          variant={canUseCurrentDirectory ? "default" : "outline"}
          className="w-full min-[420px]:w-auto"
          onClick={() => data && onValueChange(data.currentPath)}
          disabled={!canUseCurrentDirectory}
        >
          <CheckIcon data-icon="inline-start" />
          Use current
        </Button>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5 text-xs">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{selectedLabel}</span>
          <span className="truncate text-muted-foreground">
            {selectedPath || "Pick a folder below or paste an absolute path."}
          </span>
        </div>
        <div className="hidden shrink-0 items-center gap-1 min-[430px]:flex">
          {selectedEntry?.gitRepository ? (
            <Badge variant="secondary">
              <GitBranchIcon data-icon="inline-start" />
              Git
            </Badge>
          ) : null}
          {selectedEntry?.hidden ? <Badge variant="outline">Hidden</Badge> : null}
        </div>
      </div>

      <div className="subtle-scrollbar flex items-center gap-1 overflow-x-auto py-1">
        {crumbs.map((crumb, index) => (
          <React.Fragment key={crumb.path}>
            {index > 0 ? (
              <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <Button
              type="button"
              variant={index === crumbs.length - 1 ? "secondary" : "ghost"}
              size="xs"
              onClick={() => openDirectory(crumb.path)}
              disabled={disabled || index === crumbs.length - 1}
              className="max-w-36"
            >
              {index === 0 ? <HouseIcon data-icon="inline-start" /> : null}
              <span className="truncate">{crumb.label}</span>
            </Button>
          </React.Fragment>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => data?.homePath && openDirectory(data.homePath)}
          disabled={disabled || !data || data.currentPath === data.homePath}
          title="Home directory"
        >
          <HouseIcon />
          <span className="sr-only">Home directory</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => data?.parentPath && openDirectory(data.parentPath)}
          disabled={disabled || !data?.parentPath}
          title="Parent directory"
        >
          <ArrowUpIcon />
          <span className="sr-only">Parent directory</span>
        </Button>
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search folders"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this folder"
            disabled={disabled}
            className={cn("pl-7", search && "pr-7")}
          />
          {search ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setSearch("")}
              disabled={disabled}
              title="Clear search"
            >
              <XIcon />
              <span className="sr-only">Clear search</span>
            </Button>
          ) : null}
        </div>
      </div>

      <ScrollArea className="h-[min(16rem,34svh)] rounded-lg border bg-background">
        <div className="flex flex-col p-1">
          {isLoading ? (
            <div className="flex flex-col gap-1 p-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : data && data.entries.length > 0 ? (
            data.entries.map((entry) => (
              <div
                key={entry.path}
                className={cn(
                  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm min-[430px]:flex",
                  value === entry.path && "bg-muted"
                )}
                aria-current={value === entry.path ? "true" : undefined}
              >
                <button
                  type="button"
                  onClick={() => openDirectory(entry.path)}
                  onDoubleClick={() => onValueChange(entry.path)}
                  disabled={disabled || entry.unreadable}
                  title={entry.path}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
                <div className="hidden min-w-0 flex-wrap items-center gap-1 min-[430px]:flex">
                  {entry.gitRepository ? (
                    <Badge variant="secondary">
                      <GitBranchIcon data-icon="inline-start" />
                      Git
                    </Badge>
                  ) : null}
                  {entry.hidden ? (
                    <Badge variant="outline">Hidden</Badge>
                  ) : null}
                  {entry.unreadable ? (
                    <Badge variant="destructive">Locked</Badge>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant={value === entry.path ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => onValueChange(entry.path)}
                  disabled={disabled || entry.unreadable}
                >
                  {value === entry.path ? "Selected" : "Select"}
                </Button>
              </div>
            ))
          ) : (
            <div className="flex h-28 items-center justify-center px-3 text-center text-xs text-muted-foreground">
              No matching folders in this level.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

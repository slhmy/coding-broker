import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  ProjectHealth,
  SessionStatus,
  WorktreeStatus,
} from "@/types/domain"

type StatusBadgeProps = {
  value: ProjectHealth | SessionStatus | WorktreeStatus | string
}

export function StatusBadge({ value }: StatusBadgeProps) {
  const label = value.replaceAll("-", " ")

  return (
    <Badge variant="outline" className={cn("capitalize", statusColor(value))}>
      {label}
    </Badge>
  )
}

function statusColor(value: string) {
  switch (value) {
    case "idle":
      return "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-300"
    case "ready":
      return "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300"
    case "running":
      return "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
    case "failed":
    case "conflict":
    case "denied":
      return "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
    case "done":
    case "clean":
    case "active":
    case "allowed":
      return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    case "changes":
    case "dirty":
      return "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300"
    case "behind":
      return "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
    case "pending":
      return "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300"
    default:
      return "border-border bg-secondary text-secondary-foreground"
  }
}

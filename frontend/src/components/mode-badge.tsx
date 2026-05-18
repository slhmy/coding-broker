import {
  ChatCircleTextIcon,
  CheckCircleIcon,
  FileCodeIcon,
} from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { SessionMode } from "@/types/domain"

export function modeIcon(mode: SessionMode) {
  if (mode === "plan") {
    return <CheckCircleIcon data-icon="inline-start" />
  }
  if (mode === "act") {
    return <FileCodeIcon data-icon="inline-start" />
  }
  return <ChatCircleTextIcon data-icon="inline-start" />
}

export function modeColorClassName(mode: SessionMode) {
  if (mode === "plan") {
    return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300"
  }
  if (mode === "act") {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
}

export function modeAccentClassName(mode: SessionMode | undefined) {
  if (mode === "plan") {
    return "text-sky-700 dark:text-sky-300"
  }
  if (mode === "act") {
    return "text-emerald-700 dark:text-emerald-300"
  }
  if (mode === "ask") {
    return "text-amber-700 dark:text-amber-300"
  }
  return "text-primary"
}

export function modeSoftClassName(mode: SessionMode | undefined) {
  if (mode === "plan") {
    return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
  }
  if (mode === "act") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (mode === "ask") {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  return "border-primary/25 bg-primary/10 text-primary"
}

export function modeMessageClassName(mode: SessionMode | undefined) {
  if (mode === "plan") {
    return "border border-sky-500/25 bg-sky-500/10 text-foreground"
  }
  if (mode === "act") {
    return "border border-emerald-500/25 bg-emerald-500/10 text-foreground"
  }
  if (mode === "ask") {
    return "border border-amber-500/25 bg-amber-500/10 text-foreground"
  }
  return ""
}

export function modeUserMessageClassName(mode: SessionMode | undefined) {
  if (mode === "plan") {
    return "border border-sky-500/35 bg-sky-600 text-white dark:bg-sky-700"
  }
  if (mode === "act") {
    return "border border-emerald-500/35 bg-emerald-600 text-white dark:bg-emerald-700"
  }
  if (mode === "ask") {
    return "border border-amber-500/35 bg-amber-500 text-amber-950 dark:bg-amber-600 dark:text-white"
  }
  return "bg-primary text-primary-foreground"
}

export function modeLabel(mode: SessionMode) {
  return mode[0].toUpperCase() + mode.slice(1)
}

export function ModeBadge({
  mode,
  className,
}: {
  mode: SessionMode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit max-w-full shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        modeColorClassName(mode),
        className
      )}
    >
      {modeIcon(mode)}
      <span>{modeLabel(mode)}</span>
    </span>
  )
}

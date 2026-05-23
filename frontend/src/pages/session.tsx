/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import Prism from "prismjs"
import "prismjs/components/prism-bash"
import "prismjs/components/prism-css"
import "prismjs/components/prism-diff"
import "prismjs/components/prism-go"
import "prismjs/components/prism-json"
import "prismjs/components/prism-jsx"
import "prismjs/components/prism-markdown"
import "prismjs/components/prism-python"
import "prismjs/components/prism-ruby"
import "prismjs/components/prism-rust"
import "prismjs/components/prism-sql"
import "prismjs/components/prism-toml"
import "prismjs/components/prism-tsx"
import "prismjs/components/prism-typescript"
import "prismjs/components/prism-yaml"
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  BrainIcon,
  ChatCircleTextIcon,
  ClockCountdownIcon,
  CopyIcon,
  FileCodeIcon,
  GitBranchIcon,
  PaperPlaneTiltIcon,
  PaintBrushHouseholdIcon,
  PencilSimpleIcon,
  PipeWrenchIcon,
  PlusIcon,
  QuotesIcon,
  ShieldWarningIcon,
  StopIcon,
  TerminalIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import ReactMarkdown from "react-markdown"
import { Link, useNavigate, useParams } from "react-router-dom"
import remarkGfm from "remark-gfm"
import { toast } from "sonner"

import {
  modeColorClassName,
  modeAccentClassName,
  modeIcon,
  modeLabel,
  modeMessageClassName,
  modeUserMessageClassName,
} from "@/components/mode-badge"
import { ModelSelect } from "@/components/model-select"
import { StatusBadge } from "@/components/status-badge"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ApiError, api } from "@/lib/api"
import { formatPreciseDateTime, parseDateTimeMillis } from "@/lib/datetime"
import {
  buildBranchDiffDisplay,
  summarizeGitDiff,
  type BranchDiffDisplay,
} from "@/lib/git"
import {
  cancelSession as cancelStoredSession,
  clearSessionContext as clearStoredSessionContext,
  markSessionRead,
  refreshSession as refreshStoredSession,
  respondPermission as respondStoredPermission,
  sendMessage as sendStoredMessage,
  updateMode as updateStoredMode,
  updateModel as updateStoredModel,
  updateSession as updateStoredSession,
  useSessionStore,
} from "@/lib/session-store"
import { cn } from "@/lib/utils"
import type {
  AppConfig,
  Message,
  ProjectDetail,
  Session,
  SessionMode,
  TimelineEvent,
} from "@/types/domain"

export function SessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { details } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [appConfig, setAppConfig] = React.useState<AppConfig | null>(null)
  const [input, setInput] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSending, setIsSending] = React.useState(false)
  const [isCanceling, setIsCanceling] = React.useState(false)
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [isRenameDialogOpen, setIsRenameDialogOpen] = React.useState(false)
  const [isClearContextDialogOpen, setIsClearContextDialogOpen] =
    React.useState(false)
  const [isClearingContext, setIsClearingContext] = React.useState(false)
  const [renameTitle, setRenameTitle] = React.useState("")
  const [isAutoCommitEnabled, setIsAutoCommitEnabled] = React.useState(false)
  const [isAtTop, setIsAtTop] = React.useState(true)
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const [isScrollable, setIsScrollable] = React.useState(false)
  const [pendingPermissionId, setPendingPermissionId] = React.useState<
    string | null
  >(null)
  const [branchDiffDisplay, setBranchDiffDisplay] =
    React.useState<BranchDiffDisplay | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null)
  const endOfMessagesRef = React.useRef<HTMLDivElement | null>(null)
  const initializedScrollSessionRef = React.useRef<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const session = React.useMemo(
    () => (sessionId ? (details.get(sessionId) ?? null) : null),
    [details, sessionId]
  )
  const lastUserMessage = React.useMemo(
    () =>
      [...(session?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user"),
    [session?.messages]
  )
  const timelineItems = React.useMemo(
    () => buildTimelineItems(session),
    [session]
  )
  const runningDuration = useRunningDuration(session)
  const draftStorageKey = sessionId ? `coding-broker:draft:${sessionId}` : null
  const autoCommitStorageKey = sessionId
    ? `coding-broker:auto-commit:${sessionId}`
    : null
  const scrollJumpTarget =
    isScrollable && !isAtBottom
      ? "bottom"
      : isScrollable && !isAtTop
        ? "top"
        : null

  const loadSession = React.useCallback(async () => {
    if (!sessionId) {
      return
    }

    setIsLoading(true)
    const [, nextProjects, nextConfig] = await Promise.all([
      refreshStoredSession(sessionId),
      api.projects(),
      api.config(),
    ])
    setProjects(nextProjects)
    setAppConfig(nextConfig)
    setErrorMessage(null)

    setIsLoading(false)
  }, [sessionId])

  const handleMissingSession = React.useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("Session no longer exists")
        navigate("/workspace")
        return true
      }
      return false
    },
    [navigate]
  )

  React.useEffect(() => {
    loadSession().catch((error: unknown) => {
      setIsLoading(false)
      if (handleMissingSession(error)) {
        return
      }
      setErrorMessage(
        error instanceof Error ? error.message : "Session unavailable"
      )
    })
  }, [handleMissingSession, loadSession])

  React.useEffect(() => {
    if (!sessionId || !session) {
      setBranchDiffDisplay(null)
      return
    }

    let isCancelled = false
    const branchLabel =
      session.worktree?.branch ??
      projects.find((candidate) => candidate.slug === session.projectSlug)
        ?.branch ??
      "Current branch"

    api
      .getSessionGitDiff(sessionId)
      .then((diffData) => {
        if (isCancelled) {
          return
        }
        const diffSummary = summarizeGitDiff(diffData.diff)
        setBranchDiffDisplay(buildBranchDiffDisplay(branchLabel, diffSummary))
      })
      .catch(() => {
        if (!isCancelled) {
          setBranchDiffDisplay(
            buildBranchDiffDisplay(branchLabel, { additions: 0, deletions: 0 })
          )
        }
      })

    return () => {
      isCancelled = true
    }
  }, [projects, session, sessionId])

  React.useEffect(() => {
    if (!draftStorageKey) {
      return
    }

    setInput(localStorage.getItem(draftStorageKey) ?? "")
  }, [draftStorageKey])

  React.useEffect(() => {
    if (!autoCommitStorageKey) {
      return
    }

    setIsAutoCommitEnabled(
      localStorage.getItem(autoCommitStorageKey) === "true"
    )
  }, [autoCommitStorageKey])

  React.useEffect(() => {
    if (!draftStorageKey) {
      return
    }

    if (input.trim()) {
      localStorage.setItem(draftStorageKey, input)
    } else {
      localStorage.removeItem(draftStorageKey)
    }
  }, [draftStorageKey, input])

  React.useEffect(() => {
    if (!autoCommitStorageKey) {
      return
    }

    if (isAutoCommitEnabled) {
      localStorage.setItem(autoCommitStorageKey, "true")
    } else {
      localStorage.removeItem(autoCommitStorageKey)
    }
  }, [autoCommitStorageKey, isAutoCommitEnabled])

  React.useEffect(() => {
    if (!sessionId || !session) {
      return
    }
    setErrorMessage(null)
  }, [session, sessionId])

  React.useEffect(() => {
    if (
      !sessionId ||
      (session?.status !== "done" && session?.status !== "failed")
    ) {
      return
    }

    markSessionRead(sessionId).catch((error: unknown) => {
      if (handleMissingSession(error)) {
        return
      }
    })
  }, [handleMissingSession, session?.status, sessionId])

  React.useEffect(() => {
    if (isAtBottom) {
      scrollToBottom("smooth")
      scheduleScrollStateUpdate()
    }
  }, [
    isAtBottom,
    session?.messages?.length,
    session?.status,
    timelineItems.length,
  ])

  React.useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    updateScrollState()
  }, [session?.messages?.length, timelineItems.length])

  React.useEffect(() => {
    if (!sessionId || !session || isLoading) {
      return
    }

    if (initializedScrollSessionRef.current === sessionId) {
      return
    }

    initializedScrollSessionRef.current = sessionId
    const animationFrame = window.requestAnimationFrame(() => {
      scrollToBottom("auto")

      updateScrollState()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [isLoading, session, sessionId])

  React.useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const handleScroll = () => {
      updateScrollState()
    }

    scrollContainer.addEventListener("scroll", handleScroll)
    handleScroll()

    return () => scrollContainer.removeEventListener("scroll", handleScroll)
  }, [])

  async function createSession() {
    navigate("/workspace")
  }

  async function updateMode(mode: SessionMode) {
    if (!session) {
      return
    }

    try {
      await updateStoredMode(session.id, mode)
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not switch mode"
      )
    }
  }

  async function updateModel(model: string) {
    if (!session || model === session.model) {
      return
    }

    try {
      await updateStoredModel(session.id, model)
      toast.success(`Model set to ${model}`)
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not switch model"
      )
    }
  }

  async function renameSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) {
      return
    }
    const title = [...renameTitle.trim()].slice(0, 80).join("")
    if (!title) {
      toast.error("Session title is required")
      return
    }
    if (title === session.title) {
      setIsRenameDialogOpen(false)
      return
    }

    setIsRenaming(true)
    try {
      await updateStoredSession(session.id, { title })
      setIsRenameDialogOpen(false)
      toast.success("Session renamed")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not rename session"
      )
    } finally {
      setIsRenaming(false)
    }
  }

  async function clearContext() {
    if (!session) {
      return
    }

    setIsClearingContext(true)
    try {
      await clearStoredSessionContext(session.id)
      setIsClearContextDialogOpen(false)
      setInput("")
      if (draftStorageKey) {
        localStorage.removeItem(draftStorageKey)
      }
      toast.success("Context cleared")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not clear context"
      )
    } finally {
      setIsClearingContext(false)
    }
  }

  async function sendMessage() {
    if (!session || !input.trim()) {
      return
    }

    setIsSending(true)
    try {
      await sendStoredMessage(session.id, {
        content: buildOutgoingMessage(input, session.mode, isAutoCommitEnabled),
      })
      setInput("")
      if (draftStorageKey) {
        localStorage.removeItem(draftStorageKey)
      }
      setIsAtBottom(true)
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not send message"
      )
    } finally {
      setIsSending(false)
    }
  }

  async function retryLastMessage() {
    if (!session || !lastUserMessage) {
      return
    }

    setIsSending(true)
    try {
      await sendStoredMessage(session.id, {
        content: buildOutgoingMessage(
          lastUserMessage.content,
          session.mode,
          isAutoCommitEnabled
        ),
      })
      toast.success("Retry started")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(error instanceof Error ? error.message : "Could not retry")
    } finally {
      setIsSending(false)
    }
  }

  async function cancelRun() {
    if (!session) {
      return
    }

    setIsCanceling(true)
    try {
      await cancelStoredSession(session.id)
      toast.success("Agent run canceled")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error ? error.message : "Could not cancel run"
      )
    } finally {
      setIsCanceling(false)
      setIsSending(false)
    }
  }

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    endOfMessagesRef.current?.scrollIntoView({ behavior, block: "end" })
  }

  function scrollToTop(behavior: ScrollBehavior = "auto") {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior })
  }

  function updateScrollState() {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const distanceFromBottom =
      scrollContainer.scrollHeight -
      scrollContainer.scrollTop -
      scrollContainer.clientHeight

    setIsScrollable(scrollContainer.scrollHeight > scrollContainer.clientHeight + 8)
    setIsAtTop(scrollContainer.scrollTop < 80)
    setIsAtBottom(distanceFromBottom < 80)
  }

  function scheduleScrollStateUpdate() {
    updateScrollState()
    window.setTimeout(updateScrollState, 80)
    window.setTimeout(updateScrollState, 180)
    window.setTimeout(updateScrollState, 320)
  }

  function quoteMessage(message: Message) {
    const quote = message.content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    setInput((current) =>
      current.trim() ? `${current.trim()}\n\n${quote}\n` : `${quote}\n`
    )
    textareaRef.current?.focus()
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content)
      toast.success("Message copied")
    } catch {
      toast.error("Could not copy message")
    }
  }

  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey
    ) {
      return
    }

    event.preventDefault()
    void sendMessage()
  }

  async function respondPermission(
    permissionId: string,
    decision: "allow" | "deny"
  ) {
    if (!session) {
      return
    }

    setPendingPermissionId(permissionId)
    try {
      await respondStoredPermission(session.id, permissionId, decision)
      toast.success(
        decision === "allow" ? "Permission allowed" : "Permission denied"
      )
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not respond to permission"
      )
    } finally {
      setPendingPermissionId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="content-shell flex h-full flex-col gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="min-h-96 w-full flex-1 rounded-lg" />
      </div>
    )
  }

  if (errorMessage || !session) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Session unavailable</CardTitle>
            <CardDescription>
              {errorMessage ??
                "This in-memory demo session is no longer available."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={createSession}>
              <PlusIcon data-icon="inline-start" />
              New session
            </Button>
            <Button variant="outline" asChild>
              <Link to="/workspace">Back to workspace</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const selectedProject = projects.find(
    (candidate) => candidate.slug === session.projectSlug
  )
  const isAgentBusy = session.status === "running"
  const contextPath = session.worktree?.path ?? selectedProject?.path
  const projectContextText = contextPath
    ? contextPath
    : "Workspace context is missing. Start a new session from the workspace switcher."

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b bg-background/95 px-2.5 py-1.5 sm:px-4 sm:py-3 lg:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1.5 sm:gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-2">
              <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
                <h1 className="min-w-0 truncate text-sm leading-6 font-semibold sm:text-lg">
                  {session.title}
                </h1>
                <Dialog
                  open={isRenameDialogOpen}
                  onOpenChange={(open) => {
                    setIsRenameDialogOpen(open)
                    if (open) {
                      setRenameTitle(session.title)
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label="Rename session"
                    >
                      <PencilSimpleIcon data-icon="inline-start" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <form onSubmit={renameSession} className="contents">
                      <DialogHeader>
                        <DialogTitle>Rename session</DialogTitle>
                      </DialogHeader>
                      <Input
                        aria-label="Session title"
                        value={renameTitle}
                        onChange={(event) => setRenameTitle(event.target.value)}
                        maxLength={80}
                        disabled={isRenaming}
                        autoFocus
                      />
                      <DialogFooter>
                        <Button
                          type="submit"
                          disabled={isRenaming || !renameTitle.trim()}
                        >
                          {isRenaming ? "Saving" : "Save"}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
              {session.status === "running" ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:text-xs">
                  <ClockCountdownIcon data-icon="inline-start" />
                  {runningDuration}
                </span>
              ) : null}
            </div>
            <p className="mt-1 hidden truncate text-sm text-muted-foreground sm:block">
              {projectContextText}
            </p>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 sm:gap-1.5 md:w-[min(48%,28rem)] md:shrink-0 md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 min-w-0 justify-start px-1.5 text-[11px] sm:h-7 sm:text-xs"
              asChild
            >
              <Link to={`/sessions/${session.id}/branch`} className="min-w-0">
                <GitBranchIcon data-icon="inline-start" />
                <BranchDiffLabel
                  branchLabel={
                    branchDiffDisplay?.branchLabel ??
                    session.worktree?.branch ??
                    selectedProject?.branch ??
                    "Current branch"
                  }
                  additions={branchDiffDisplay?.additions ?? 0}
                  deletions={branchDiffDisplay?.deletions ?? 0}
                />
              </Link>
            </Button>
            <StatusBadge value={session.status} />
            <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
              {(session.status === "failed" ||
                isLikelyTimedOut(session, runningDuration)) &&
              lastUserMessage ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={retryLastMessage}
                  disabled={isSending}
                >
                  <ArrowClockwiseIcon data-icon="inline-start" />
                  Retry
                </Button>
              ) : null}
              <Dialog
                open={isClearContextDialogOpen}
                onOpenChange={(open) => {
                  if (!isClearingContext) {
                    setIsClearContextDialogOpen(open)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0"
                    disabled={isAgentBusy}
                    aria-label="Clear context"
                    title="Clear context"
                  >
                    <PaintBrushHouseholdIcon />
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Clear context</DialogTitle>
                  </DialogHeader>
                  <p className="text-sm text-muted-foreground">
                    Delete this session&apos;s messages and pending permissions.
                    The workspace and worktree stay in place.
                  </p>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isClearingContext}
                      onClick={() => setIsClearContextDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isClearingContext}
                      onClick={clearContext}
                    >
                      {isClearingContext ? "Clearing" : "Clear"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1">
        <section className="min-h-0 min-w-0">
          <div className="relative mx-auto grid h-full w-full max-w-6xl min-w-0 grid-rows-[minmax(0,1fr)_auto] px-2 pt-2 sm:px-4 sm:pt-4 xl:px-6 xl:pt-6">
            <div
              ref={scrollContainerRef}
              className="subtle-scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
            >
              <div className="flex w-full max-w-full min-w-0 flex-col gap-2.5 px-0 pb-3 sm:gap-3 sm:px-1 sm:pb-4">
                <PermissionPanel
                  session={session}
                  pendingPermissionId={pendingPermissionId}
                  onRespond={respondPermission}
                />
                {timelineItems.length === 0 ? (
                  <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 px-4 text-center sm:min-h-72">
                    <ChatCircleTextIcon />
                    <div className="text-sm font-medium">
                      Start the conversation
                    </div>
                    <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                      The mode selector changes how this session responds; the
                      thread stays in one place.
                    </p>
                  </div>
                ) : (
                  <>
                    {timelineItems.map((item) =>
                      item.type === "message" ? (
                        <MessageBubble
                          key={item.message.id}
                          message={item.message}
                          mode={item.mode}
                          onCopy={copyMessage}
                          onQuote={quoteMessage}
                        />
                      ) : item.type === "system-group" ? (
                        <SystemMessageGroupBubble
                          key={item.id}
                          messages={item.messages}
                          mode={item.mode}
                        />
                      ) : item.type === "tool" ? (
                        <MergedToolEventBubble
                          key={item.id}
                          call={item.call}
                          result={item.result}
                          mode={item.mode}
                          isRunning={isAgentBusy}
                        />
                      ) : item.type === "tool-group" ? (
                        <BashToolGroupBubble
                          key={item.id}
                          items={item.items}
                          mode={item.mode}
                          isRunning={isAgentBusy}
                        />
                      ) : (
                        <TimelineEventBubble
                          key={item.event.id}
                          event={item.event}
                          mode={item.mode}
                          isRunning={isAgentBusy}
                        />
                      )
                    )}
                    {isAgentBusy ? (
                      <AgentRunningIndicator mode={session.mode} />
                    ) : null}
                    <ChangePreview messages={session.messages} />
                  </>
                )}
                <div ref={endOfMessagesRef} />
              </div>
            </div>
            {scrollJumpTarget ? (
              <Button
                variant="outline"
                size="sm"
                className="absolute bottom-36 left-1/2 z-20 -translate-x-1/2 shadow-md sm:bottom-36"
                onClick={() => {
                  if (scrollJumpTarget === "bottom") {
                    scrollToBottom("smooth")
                  } else {
                    scrollToTop("smooth")
                  }
                  scheduleScrollStateUpdate()
                }}
              >
                {scrollJumpTarget === "bottom" ? (
                  <>
                    <ArrowDownIcon data-icon="inline-start" />
                    Latest
                  </>
                ) : (
                  <>
                    <ArrowUpIcon data-icon="inline-start" />
                    Top
                  </>
                )}
              </Button>
            ) : null}
            <Composer
              session={session}
              input={input}
              isSending={isSending}
              lastUserMessage={lastUserMessage}
              textareaRef={textareaRef}
              onInputChange={setInput}
              onKeyDown={handleComposerKeyDown}
              onModeChange={updateMode}
              onModelChange={updateModel}
              onQuote={quoteMessage}
              onSend={sendMessage}
              onCancel={cancelRun}
              isAutoCommitEnabled={isAutoCommitEnabled}
              onAutoCommitChange={setIsAutoCommitEnabled}
              isAgentBusy={isAgentBusy}
              isCanceling={isCanceling}
              availableModels={appConfig?.availableModels ?? []}
              selectedModel={session.model || appConfig?.defaultModel || ""}
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function BranchDiffLabel({
  branchLabel,
  additions,
  deletions,
}: {
  branchLabel: string
  additions: number
  deletions: number
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <span className="truncate">{branchLabel}</span>
      <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
        +{additions}
      </span>
      <span className="shrink-0 text-muted-foreground">/</span>
      <span className="shrink-0 text-rose-600 dark:text-rose-400">
        -{deletions}
      </span>
    </span>
  )
}

function Composer({
  session,
  input,
  isSending,
  isAgentBusy,
  lastUserMessage,
  textareaRef,
  onInputChange,
  onKeyDown,
  onModeChange,
  onModelChange,
  onQuote,
  onSend,
  onCancel,
  isAutoCommitEnabled,
  onAutoCommitChange,
  isCanceling,
  availableModels,
  selectedModel,
}: {
  session: Session
  input: string
  isSending: boolean
  isAgentBusy: boolean
  isCanceling: boolean
  lastUserMessage: Message | undefined
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onInputChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onModeChange: (mode: SessionMode) => void
  onModelChange: (model: string) => void
  onQuote: (message: Message) => void
  onSend: () => void
  onCancel: () => void
  isAutoCommitEnabled: boolean
  onAutoCommitChange: (enabled: boolean) => void
  availableModels: string[]
  selectedModel: string
}) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const trimmedInput = input.trim()
  const shouldReuse = Boolean(lastUserMessage && !trimmedInput)
  const actionDisabled = isSending || (!trimmedInput && !lastUserMessage)

  return (
    <div className="shrink-0 bg-background pt-1.5 pb-2 sm:pt-3 sm:pb-3 lg:pb-4">
      <div className="flex w-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
        <div className="relative p-1.5 sm:p-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={modePlaceholder(session.mode)}
            className={cn(
              "min-h-11 resize-none border-0 bg-transparent px-1.5 py-1 pr-9 text-base leading-relaxed shadow-none transition-[min-height,max-height] focus-visible:ring-0 md:text-sm sm:min-h-16",
              isExpanded
                ? "min-h-40 max-h-[min(52vh,28rem)] overflow-y-auto sm:min-h-56"
                : "max-h-24 overflow-y-auto sm:max-h-36"
            )}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2 aria-pressed:bg-muted aria-pressed:text-foreground sm:top-2.5 sm:right-2.5"
            onClick={() => {
              setIsExpanded((current) => !current)
              window.requestAnimationFrame(() => textareaRef.current?.focus())
            }}
            aria-pressed={isExpanded}
            aria-label={isExpanded ? "Collapse editor" : "Expand editor"}
            title={isExpanded ? "Collapse editor" : "Expand editor"}
          >
            {isExpanded ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
          </Button>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-1 border-t bg-muted/20 px-1.5 py-1 sm:px-2 sm:py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <div className="grid min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] gap-1 sm:flex sm:items-center sm:gap-1.5">
              <ModeSelect value={session.mode} onValueChange={onModeChange} />
              {session.mode === "act" ? (
                <label
                  className="inline-flex h-7 w-auto shrink-0 items-center justify-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-muted-foreground sm:text-xs"
                  title="Auto commit"
                >
                  <input
                    type="checkbox"
                    checked={isAutoCommitEnabled}
                    onChange={(event) =>
                      onAutoCommitChange(event.target.checked)
                    }
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="whitespace-nowrap">
                    Auto commit
                  </span>
                </label>
              ) : null}
              <ModelSelect
                models={availableModels}
                value={selectedModel}
                onValueChange={onModelChange}
                className="h-7 min-w-0 text-xs sm:w-44"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <div className="hidden min-w-0 truncate px-1 text-xs leading-relaxed text-muted-foreground sm:block">
              {isAgentBusy
                ? "Send to queue for the next turn"
                : session.mode === "act" && isAutoCommitEnabled
                  ? "Auto commit enabled"
                  : "Enter to send, Shift+Enter for newline"}
            </div>
            {isAgentBusy && !trimmedInput ? (
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onCancel}
                disabled={isCanceling}
                aria-label={isCanceling ? "Canceling run" : "Cancel run"}
                title={isCanceling ? "Canceling" : "Cancel"}
              >
                <StopIcon />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant={shouldReuse ? "outline" : "default"}
                onClick={() => {
                  if (shouldReuse && lastUserMessage) {
                    onQuote(lastUserMessage)
                    return
                  }
                  onSend()
                }}
                disabled={actionDisabled}
                aria-label={
                  shouldReuse
                    ? "Reuse last message"
                    : isSending
                      ? "Sending message"
                      : "Send message"
                }
                title={shouldReuse ? "Reuse" : isSending ? "Sending" : "Send"}
              >
                {shouldReuse ? <QuotesIcon /> : <PaperPlaneTiltIcon />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const AUTO_COMMIT_PROMPT =
  "After completing the requested changes and verification, stage the relevant files and create a git commit with a concise commit message. Do not push unless I explicitly ask."

function buildOutgoingMessage(
  input: string,
  mode: SessionMode,
  isAutoCommitEnabled: boolean
) {
  const trimmedInput = input.trim()
  if (!trimmedInput || mode !== "act" || !isAutoCommitEnabled) {
    return trimmedInput
  }

  return `${trimmedInput}\n\nCommit prompt: ${AUTO_COMMIT_PROMPT}`
}

function PermissionPanel({
  session,
  pendingPermissionId,
  onRespond,
}: {
  session: Session
  pendingPermissionId: string | null
  onRespond: (permissionId: string, decision: "allow" | "deny") => void
}) {
  const pendingPermissions = session.permissions.filter(
    (permission) => permission.status === "pending"
  )

  if (pendingPermissions.length === 0) {
    return null
  }

  return (
    <div className="flex w-full max-w-full min-w-0 flex-col gap-2 rounded-lg border bg-card p-2.5 text-card-foreground shadow-sm sm:p-3">
      <div className="text-sm font-medium">Permission required</div>
      {pendingPermissions.map((permission) => (
        <div
          key={permission.id}
          className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-3"
        >
          <div className="text-xs font-medium">
            {permission.toolName || "Tool request"}
          </div>
          <pre className="subtle-scrollbar max-h-40 max-w-full overflow-auto text-xs [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground">
            {permission.toolInput || permission.requestId}
          </pre>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              size="sm"
              className="w-full"
              onClick={() => onRespond(permission.id, "allow")}
              disabled={pendingPermissionId === permission.id}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => onRespond(permission.id, "deny")}
              disabled={pendingPermissionId === permission.id}
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function MessageBubble({
  message,
  mode,
  onCopy,
  onQuote,
}: {
  message: Message
  mode?: SessionMode
  onCopy: (message: Message) => void
  onQuote: (message: Message) => void
}) {
  if (message.role === "system") {
    const systemMessage = parseSystemMessage(message.content)
    const messageTime = formatPreciseDateTime(message.createdAt)

    if (systemMessage.isCollapsible) {
      return (
        <details
          className="group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-muted-foreground shadow-sm sm:max-w-[92%]"
          title={messageTime}
        >
          <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
            <span className="flex min-w-0 items-start gap-2 break-words">
              <SystemMessageIcon title={systemMessage.title} mode={mode} />
              <span className="min-w-0">
                <span className="mr-1 font-medium text-foreground">
                  {systemMessage.label}
                </span>
                {systemMessage.summary}
              </span>
            </span>
            <span className="flex w-12 shrink-0 items-center justify-end gap-2 text-muted-foreground">
              <span className="group-open:hidden">Show</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          {systemMessage.detail ? (
            <pre className="subtle-scrollbar mt-2 max-h-64 max-w-full overflow-auto border-t pt-2 text-xs [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground">
              {systemMessage.detail}
            </pre>
          ) : null}
        </details>
      )
    }

    return (
      <div
        className="group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground shadow-sm sm:max-w-[92%]"
        title={messageTime}
      >
        <div className="flex items-start gap-2">
          <SystemMessageIcon title={systemMessage.title} mode={mode} />
          <span className="min-w-0">{message.content}</span>
        </div>
        <div className="mt-1 hidden text-xs text-muted-foreground group-hover:block">
          {messageTime}
        </div>
      </div>
    )
  }

  const messageTime = formatPreciseDateTime(message.createdAt)
  const messageMode = message.mode ?? mode

  return (
    <div
      className={cn(
        "group flex w-full min-w-0 flex-col gap-1",
        message.role === "user" ? "items-end" : "items-start"
      )}
    >
      <div
        className={cn(
          "max-w-full min-w-0",
          message.role === "user"
            ? cn(
                "max-w-full rounded-lg p-3.5 text-sm leading-relaxed break-words whitespace-pre-wrap sm:max-w-[92%] sm:p-3 lg:max-w-[84%]",
                modeUserMessageClassName(messageMode)
              )
            : cn(
                "max-w-full rounded-lg bg-muted p-3.5 text-sm leading-relaxed break-words sm:max-w-[92%] sm:p-3 lg:max-w-[84%]",
                modeMessageClassName(messageMode)
              )
        )}
      >
        <RichMessageContent
          content={message.content}
          isUser={message.role === "user"}
        />
      </div>
      <div className="hidden max-w-full flex-wrap items-center gap-1 sm:flex sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
        <span className="px-1 text-xs text-muted-foreground">
          {messageTime}
        </span>
        <Button variant="ghost" size="xs" onClick={() => onCopy(message)}>
          <CopyIcon data-icon="inline-start" />
          Copy
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onQuote(message)}>
          <QuotesIcon data-icon="inline-start" />
          Quote
        </Button>
      </div>
    </div>
  )
}

function SystemMessageGroupBubble({
  messages,
  mode,
}: {
  messages: Message[]
  mode?: SessionMode
}) {
  const parsedMessages = messages.map((message) => ({
    message,
    parsed: parseSystemMessage(message.content),
  }))
  const firstEntry = parsedMessages[0]

  if (!firstEntry) {
    return null
  }

  const firstParsed = firstEntry.parsed
  const lastMessage = messages[messages.length - 1]
  const timeLabel =
    messages.length === 1
      ? formatPreciseDateTime(firstEntry.message.createdAt)
      : `${formatPreciseDateTime(firstEntry.message.createdAt)} - ${formatPreciseDateTime(lastMessage.createdAt)}`
  const countLabel = messages.length > 1 ? `${messages.length}x` : null

  if (firstParsed.groupKind === "tool") {
    const toolSummary = summarizeToolGroup(parsedMessages)
    return (
      <details
        className="group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-muted-foreground shadow-sm sm:max-w-[92%]"
        title={timeLabel}
      >
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <TerminalIcon className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="mr-1 font-medium text-foreground">
                {toolSummary.isBash ? "Bash" : "Tool call"}
              </span>
              {toolSummary.label}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
            {countLabel ? <span>{countLabel}</span> : null}
            <SystemMessageGroupMeta timeLabel={timeLabel} />
          </span>
        </summary>
        <div className="mt-2 flex max-w-full min-w-0 flex-col gap-2 border-t pt-2">
          {parsedMessages.map(({ message, parsed }) => (
            <ToolCallEvent
              key={message.id}
              parsed={parsed}
              timeLabel={formatPreciseDateTime(message.createdAt)}
            />
          ))}
        </div>
      </details>
    )
  }

  return (
    <details
      open
      className="group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-muted-foreground shadow-sm sm:max-w-[92%]"
      title={timeLabel}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
        <span className="flex min-w-0 items-start gap-2 break-words">
          <SystemMessageIcon title={firstParsed.title} mode={mode} />
          <span className="min-w-0">
            <span className="mr-1 font-medium text-foreground">
              {firstParsed.label}
            </span>
            {summarizeThinkingGroup(parsedMessages)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {countLabel ? <span>{countLabel}</span> : null}
          <SystemMessageGroupMeta timeLabel={timeLabel} />
        </span>
      </summary>
      <div className="mt-2 flex max-w-full min-w-0 flex-col gap-2 border-t pt-2">
        {parsedMessages.map(({ message, parsed }) => (
          <div
            key={message.id}
            className="max-w-full min-w-0 rounded-md border bg-muted/30 px-2 py-1.5"
            title={formatPreciseDateTime(message.createdAt)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <SystemMessageIcon title={parsed.title} mode={mode} />
                <div className="min-w-0 font-medium text-foreground">
                  {parsed.summary || parsed.label}
                </div>
              </div>
            </div>
            {parsed.detail ? (
              <pre className="subtle-scrollbar mt-1 max-h-48 max-w-full overflow-auto text-[11px] [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground">
                {parsed.detail}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  )
}

function ToolCallEvent({
  parsed,
  timeLabel,
}: {
  parsed: ReturnType<typeof parseSystemMessage>
  timeLabel: string
}) {
  const event = parseToolEvent(parsed.title, parsed.detail)
  const isBash = event.toolLabel === "exec_command"

  return (
    <div
      className="w-full max-w-full min-w-0 rounded-md border bg-muted/30 px-2 py-1.5"
      title={timeLabel}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
        <SystemMessageIcon title={parsed.title} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">
              {event.toolLabel}
            </span>
            {event.summary ? (
              <span className="min-w-0 max-w-full break-words whitespace-normal font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
                {event.summary}
              </span>
            ) : isBash ? (
              <span className="min-w-0 max-w-full break-words whitespace-normal font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
                {summarizeToolDetail(event.detail)}
              </span>
            ) : (
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] leading-none",
                  event.status === "failed"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : event.status === "succeeded"
                      ? "border-primary/25 bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground"
                )}
              >
                {event.statusLabel}
              </span>
            )}
          </div>
          {event.meta.length > 0 ? (
            <div className="mt-1 flex min-w-0 flex-wrap gap-1">
              {event.meta.map((item) => (
                <span
                  key={`${item.label}:${item.value}`}
                  className="max-w-full min-w-0 rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <span className="text-foreground/70">{item.label}</span>{" "}
                  <span className="break-all">{item.value}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {isBash ? (
          <span className="text-[10px] text-muted-foreground">
            {parsed.title === "Tool started" ? "start" : "done"}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {parsed.title === "Tool started" ? "start" : "done"}
          </span>
        )}
      </div>
      {event.detail ? (
        <pre className="subtle-scrollbar mt-2 max-h-56 max-w-full overflow-auto rounded border bg-background p-2 text-[11px] leading-relaxed">
          {event.isPatch || looksLikeDiff(event.detail) ? (
            <DiffLines content={event.detail} />
          ) : (
            <code className="[overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground">
              {event.detail}
            </code>
          )}
        </pre>
      ) : null}
    </div>
  )
}

function SystemMessageGroupMeta({ timeLabel }: { timeLabel: string }) {
  return (
    <span
      className="inline-flex w-9 shrink-0 justify-end text-right"
      title={timeLabel}
    >
      <span className="group-open:hidden">Show</span>
      <span className="hidden group-open:inline">Hide</span>
    </span>
  )
}

function AgentRunningIndicator({ mode }: { mode: SessionMode }) {
  return (
    <div
      className={cn(
        "agent-running-card mr-auto flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm sm:max-w-[92%]",
        modeMessageClassName(mode)
      )}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span
          className={cn(
            "agent-running-ping absolute inline-flex size-3 rounded-full opacity-40",
            mode === "plan"
              ? "bg-sky-500"
              : mode === "act"
                ? "bg-emerald-500"
                : "bg-amber-500"
          )}
        />
        <BrainIcon
          className={cn("relative size-4", modeAccentClassName(mode))}
        />
      </span>
      <span className="font-medium text-foreground">Agent running</span>
      <span className="agent-running-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  )
}

function MergedToolEventBubble({
  call,
  result,
  mode,
  isRunning,
}: {
  call: TimelineEvent
  result: TimelineEvent
  mode?: SessionMode
  isRunning?: boolean
}) {
  const timeLabel = `${formatPreciseDateTime(call.createdAt)} - ${formatPreciseDateTime(result.createdAt)}`
  const callDetail = timelineEventDetail(call)
  const resultDetail = timelineEventDetail(result)
  const toolName = stringPayload(result.payload.toolName) || "Tool"
  const status = stringPayload(result.payload.toolStatus) || "finished"
  const failed = result.payload.toolSuccess === false || /fail/i.test(status)
  const summary = mergedToolSummary(call, result)

  return (
    <details
      className={cn(
        "group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]",
        isRunning && "agent-running-card"
      )}
      title={timeLabel}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 marker:content-none">
        <span className="flex min-w-0 items-start gap-2 break-words">
          <TerminalIcon
            className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
          />
          <span className="min-w-0">
            <span className="mr-1 font-medium text-foreground">{toolName}</span>
            {failed ? (
              <span className="mr-1 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] leading-none text-destructive">
                Failed
              </span>
            ) : null}
            {summary}
          </span>
        </span>
        <SystemMessageGroupMeta timeLabel={timeLabel} />
      </summary>
      <div className="mt-2 flex max-w-full min-w-0 flex-col gap-2 border-t pt-2">
        {callDetail ? (
          <ToolEventDetail title="Started" detail={callDetail} />
        ) : null}
        {resultDetail ? (
          <ToolEventDetail title="Finished" detail={resultDetail} />
        ) : null}
      </div>
    </details>
  )
}

function BashToolGroupBubble({
  items,
  mode,
  isRunning,
}: {
  items: ToolTimelineItem[]
  mode?: SessionMode
  isRunning?: boolean
}) {
  if (items.length === 0) {
    return null
  }

  const first = items[0]
  const last = items[items.length - 1]
  const timeLabel = `${formatPreciseDateTime(first.call.createdAt)} - ${formatPreciseDateTime(last.result.createdAt)}`
  const summaries = items
    .map((item) => mergedToolSummary(item.call, item.result))
    .filter(Boolean)
    .slice(0, 3)

  return (
    <details
      className={cn(
        "group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]",
        isRunning && "agent-running-card"
      )}
      title={timeLabel}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 marker:content-none">
        <span className="flex min-w-0 items-start gap-2 break-words">
          <TerminalIcon
            className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
          />
          <span className="min-w-0">
            <span className="mr-1 font-medium text-foreground">Bash</span>
            <span className="mr-1 text-foreground/70">
              {items.length} command{items.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
              {summaries.join(" • ")}
            </span>
          </span>
        </span>
        <SystemMessageGroupMeta timeLabel={timeLabel} />
      </summary>
      <div className="mt-2 flex max-w-full min-w-0 flex-col gap-2 border-t pt-2">
        {items.map((item) => (
          <ToolEventDetail
            key={`${item.call.id}:${item.result.id}`}
            title={mergedToolSummary(item.call, item.result) || "Command"}
            detail={timelineEventDetail(item.result)}
          />
        ))}
      </div>
    </details>
  )
}

function ToolEventDetail({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="max-w-full min-w-0 rounded-md border bg-muted/30 px-2 py-1.5">
      <div className="mb-1 text-[10px] font-medium text-foreground/70">
        {title}
      </div>
      <pre className="subtle-scrollbar max-h-56 max-w-full overflow-auto rounded border bg-background p-2 text-[11px] leading-relaxed">
        {looksLikeDiff(detail) ? (
          <DiffLines content={detail} />
        ) : (
          <PrismCode code={detail} language={inferPrismLanguage("", detail)} />
        )}
      </pre>
    </div>
  )
}

function TimelineEventBubble({
  event,
  mode,
  isRunning,
}: {
  event: TimelineEvent
  mode?: SessionMode
  isRunning?: boolean
}) {
  const timeLabel = formatPreciseDateTime(event.createdAt)

  if (event.kind === "file_change") {
    return (
      <FileChangeEventBubble event={event} timeLabel={timeLabel} mode={mode} />
    )
  }

  const detail = timelineEventDetail(event)
  const isCollapsible =
    event.kind === "thinking" ||
    event.kind === "tool_call" ||
    event.kind === "tool_result" ||
    event.kind === "permission_request"

  if (isCollapsible) {
    return (
      <details
        className={cn(
          "group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]",
          isRunning && "agent-running-card"
        )}
        title={timeLabel}
      >
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 marker:content-none">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <TimelineEventIcon event={event} mode={mode} />
            <span className="min-w-0">
              <span className="mr-1 font-medium text-foreground">
                {event.title}
              </span>
              {event.summary}
            </span>
          </span>
          <SystemMessageGroupMeta timeLabel={timeLabel} />
        </summary>
        {detail ? (
          <pre className="subtle-scrollbar mt-2 max-h-64 max-w-full overflow-auto border-t pt-2 text-[11px] [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground">
            {looksLikeDiff(detail) ? (
              <DiffLines content={detail} />
            ) : (
              <PrismCode
                code={detail}
                language={inferPrismLanguage("", detail)}
              />
            )}
          </pre>
        ) : null}
      </details>
    )
  }

  return (
    <div
      className={cn(
        "group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground shadow-sm sm:max-w-[92%]",
        isRunning && "agent-running-card"
      )}
      title={timeLabel}
    >
      <div className="flex items-start gap-2">
        <TimelineEventIcon event={event} mode={mode} />
        <span className="min-w-0">
          <span className="mr-1 font-medium text-foreground">
            {event.title}
          </span>
          {event.summary}
        </span>
      </div>
    </div>
  )
}

function FileChangeEventBubble({
  event,
  timeLabel,
  mode,
}: {
  event: TimelineEvent
  timeLabel: string
  mode?: SessionMode
}) {
  const files = timelineFileChanges(event.payload)
  const additions = numberPayload(event.payload.additions)
  const deletions = numberPayload(event.payload.deletions)
  const patch = stringPayload(event.payload.patch)
  const truncated = Boolean(event.payload.truncated)

  return (
    <div
      className="group mr-auto max-w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-muted-foreground shadow-sm sm:max-w-[92%]"
      title={timeLabel}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <span className="flex min-w-0 items-start gap-2 break-words">
          <FileCodeIcon
            className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
          />
          <span className="min-w-0">
            <span className="mr-1 font-medium text-foreground">
              {event.title || "Code edited"}
            </span>
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? "" : "s"}`
              : event.summary}
            {additions || deletions ? (
              <span className="ml-1 font-mono">
                +{additions} -{deletions}
              </span>
            ) : null}
          </span>
        </span>
        <span
          className="inline-flex w-9 shrink-0 justify-end text-right text-muted-foreground"
          title={timeLabel}
        />
      </div>
      {files.length > 0 ? (
        <div className="mt-2 flex max-w-full min-w-0 flex-wrap gap-1 border-t pt-2">
          {files.slice(0, 8).map((file) => (
            <span
              key={`${file.path}:${file.operation}`}
              className="max-w-full rounded border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] [overflow-wrap:anywhere] text-muted-foreground"
            >
              {file.operation} {file.path}
            </span>
          ))}
        </div>
      ) : null}
      {patch ? (
        <pre className="mt-2 max-w-full rounded border bg-background p-2 text-[11px] leading-relaxed">
          <DiffLines content={patch} files={files.map((file) => file.path)} />
          {truncated ? (
            <span className="block px-1 text-muted-foreground">
              Output truncated
            </span>
          ) : null}
        </pre>
      ) : null}
    </div>
  )
}

function TimelineEventIcon({
  event,
  mode,
}: {
  event: TimelineEvent
  mode?: SessionMode
}) {
  if (event.kind === "thinking") {
    return (
      <BrainIcon className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))} />
    )
  }
  if (event.kind === "tool_call") {
    return (
      <TerminalIcon
        className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
      />
    )
  }
  if (event.kind === "tool_result") {
    return (
      <PipeWrenchIcon
        className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
      />
    )
  }
  if (event.kind === "permission_request") {
    return <ShieldWarningIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  if (event.kind === "error") {
    return <WarningCircleIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  return (
    <ChatCircleTextIcon className="mt-0.5 shrink-0 text-muted-foreground" />
  )
}

function timelineEventDetail(event: TimelineEvent) {
  const input = stringPayload(event.payload.toolInput)
  const result = stringPayload(event.payload.toolResult)
  const content = stringPayload(event.payload.content)
  if (input && result) {
    return `${input}\n\n${result}`
  }
  return input || result || content
}

function timelineFileChanges(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.files)) {
    return []
  }
  return payload.files
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null
      }
      const record = item as Record<string, unknown>
      const path = stringPayload(record.path)
      if (!path) {
        return null
      }
      return {
        path,
        operation: stringPayload(record.operation) || "modified",
      }
    })
    .filter((item): item is { path: string; operation: string } =>
      Boolean(item)
    )
}

function mergedToolSummary(call: TimelineEvent, result: TimelineEvent) {
  const input = stringPayload(call.payload.toolInput)
  const resultText = stringPayload(result.payload.toolResult)
  const content = stringPayload(result.payload.content)
  const inputSummary = summarizeToolDetail(input)
  if (inputSummary) {
    return inputSummary
  }
  const resultSummary = summarizeToolDetail(resultText)
  if (resultSummary) {
    return resultSummary
  }
  return summarizeToolDetail(content) || call.summary || result.summary
}

function summarizeToolDetail(value: string) {
  const normalized = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find(
      (line) => !/^(Bash|Tool)\s+(succeeded|completed|finished)$/i.test(line)
    )
  return normalized ? compactText(normalized) : ""
}

function stringPayload(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function numberPayload(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function RichMessageContent({
  content,
  isUser,
}: {
  content: string
  isUser: boolean
}) {
  return (
    <div
      className={cn(
        "markdown-body w-full min-w-0 text-[15px] leading-7 sm:text-sm sm:leading-relaxed",
        isUser && "text-primary-foreground"
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              className="underline underline-offset-2"
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const raw = String(children).replace(/\n$/, "")
            const language = className?.match(/language-(\w+)/)?.[1] ?? ""
            return (
              <code className="rounded bg-background/70 px-1 py-0.5 text-[0.85em]">
                {language ? raw : children}
              </code>
            )
          },
          pre: ({ children }) => {
            const codeElement = React.isValidElement(children) ? children : null
            const codeProps =
              codeElement?.props && typeof codeElement.props === "object"
                ? (codeElement.props as {
                    children?: React.ReactNode
                    className?: string
                  })
                : null
            const raw = String(codeProps?.children ?? "").replace(/\n$/, "")
            const language =
              codeProps?.className?.match(/language-(\w+)/)?.[1] ?? ""
            return (
              <pre
                className={cn(
                  "subtle-scrollbar max-w-full min-w-0 overflow-auto rounded-md border border-l-4 p-3 text-xs leading-relaxed shadow-inner",
                  isUser
                    ? "border-primary-foreground/45 border-l-primary-foreground/70 bg-background/95 text-foreground"
                    : "border-border border-l-muted-foreground/40 bg-zinc-950 text-zinc-100 dark:bg-zinc-950"
                )}
              >
                {language === "diff" || looksLikeDiff(raw) ? (
                  <DiffLines content={raw} />
                ) : (
                  <PrismCode code={raw} language={language} />
                )}
              </pre>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function parseSystemMessage(content: string) {
  const [title = "Agent event", ...detailLines] = content.split("\n")
  const detail = detailLines.join("\n").trim()
  const isCollapsible =
    title === "Thinking" ||
    title === "Tool started" ||
    title === "Tool finished"

  return {
    title,
    detail,
    isCollapsible,
    label: systemMessageLabel(title),
    summary: summarizeSystemMessage(title, detail),
    groupKind: systemMessageGroupKind(title),
  }
}

function SystemMessageIcon({
  title,
  mode,
}: {
  title: string
  mode?: SessionMode
}) {
  if (title === "Thinking") {
    return (
      <BrainIcon className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))} />
    )
  }
  if (title === "Tool started") {
    return (
      <TerminalIcon
        className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
      />
    )
  }
  if (title === "Tool finished") {
    return (
      <PipeWrenchIcon
        className={cn("mt-0.5 shrink-0", modeAccentClassName(mode))}
      />
    )
  }
  if (title === "Permission requested") {
    return <ShieldWarningIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  if (title === "Agent error") {
    return <WarningCircleIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  return (
    <ChatCircleTextIcon className="mt-0.5 shrink-0 text-muted-foreground" />
  )
}

function systemMessageLabel(title: string) {
  if (title === "Thinking") {
    return "Thinking"
  }
  if (title === "Tool started") {
    return "Tool call"
  }
  if (title === "Tool finished") {
    return "Tool result"
  }
  if (title === "Permission requested") {
    return "Permission"
  }
  if (title === "Agent error") {
    return "Error"
  }
  return title
}

function systemMessageGroupKind(title: string): "thinking" | "tool" | "other" {
  if (title === "Thinking") {
    return "thinking"
  }
  if (title === "Tool started" || title === "Tool finished") {
    return "tool"
  }
  return "other"
}

function summarizeSystemMessage(title: string, detail: string) {
  const detailLines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const firstLine = detailLines[0] ?? ""
  const secondLine = detailLines[1] ?? ""

  if (title === "Thinking") {
    return firstLine ? compactText(firstLine) : ""
  }

  if (title === "Tool started") {
    const toolName = firstLine.replace(/^Using\s+/i, "") || "Tool"
    return secondLine
      ? `${toolName}: ${compactText(secondLine)}`
      : `${toolName} started`
  }

  if (title === "Tool finished") {
    const toolLine = firstLine || "Tool finished"
    const resultLine = secondLine || detailLines[2] || ""
    return resultLine
      ? `${compactText(toolLine)}: ${compactText(resultLine)}`
      : compactText(toolLine)
  }

  return compactText(firstLine || title)
}

function compactText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 120) {
    return normalized
  }
  return `${normalized.slice(0, 117)}...`
}

function compactThinkingText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 120) {
    return normalized
  }
  return `${normalized.slice(0, 117)}...`
}

type TimelineItem =
  | { type: "message"; message: Message; mode?: SessionMode }
  | {
      type: "system-group"
      id: string
      messages: Message[]
      mode?: SessionMode
    }
  | { type: "event"; event: TimelineEvent; mode?: SessionMode }
  | {
      type: "tool-group"
      id: string
      items: ToolTimelineItem[]
      mode?: SessionMode
    }
  | {
      type: "tool"
      id: string
      call: TimelineEvent
      result: TimelineEvent
      mode?: SessionMode
    }

type ToolTimelineItem = {
  call: TimelineEvent
  result: TimelineEvent
  mode?: SessionMode
}

function buildTimelineItems(session: Session | null): TimelineItem[] {
  if (!session) {
    return []
  }

  const entries: Array<
    | { kind: "message"; message: Message; createdAt: string; id: string }
    | { kind: "event"; event: TimelineEvent; createdAt: string; id: string }
  > = [
    ...session.messages.map((message) => ({
      kind: "message" as const,
      message,
      createdAt: message.createdAt,
      id: message.id,
    })),
    ...session.timelineEvents.map((event) => ({
      kind: "event" as const,
      event,
      createdAt: event.createdAt,
      id: event.id,
    })),
  ].sort((left, right) => {
    const leftTime = parseDateTimeMillis(left.createdAt) ?? 0
    const rightTime = parseDateTimeMillis(right.createdAt) ?? 0
    const timeComparison = leftTime - rightTime
    if (timeComparison !== 0) {
      return timeComparison
    }
    return left.id.localeCompare(right.id)
  })

  const items: TimelineItem[] = []
  let activeMode: SessionMode | undefined
  for (const entry of entries) {
    if (entry.kind === "event") {
      const eventMode = timelineEventMode(entry.event) ?? activeMode
      const pendingToolCallIndex = findPendingToolCallIndex(items, entry.event)
      if (pendingToolCallIndex >= 0) {
        const pendingToolCall = items[pendingToolCallIndex]
        if (pendingToolCall.type === "event") {
          const mode = pendingToolCall.mode ?? eventMode
          if (isBashToolEvent(pendingToolCall.event)) {
            const bashItem: ToolTimelineItem = {
              call: pendingToolCall.event,
              result: entry.event,
              mode,
            }
            const previous = items[pendingToolCallIndex - 1]
            if (previous?.type === "tool-group" && previous.mode === mode) {
              previous.items.push(bashItem)
              items.splice(pendingToolCallIndex, 1)
            } else {
              items[pendingToolCallIndex] = {
                type: "tool-group",
                id: `${pendingToolCall.event.id}:${entry.event.id}`,
                items: [bashItem],
                mode,
              }
            }
          } else {
            items[pendingToolCallIndex] = {
              type: "tool",
              id: `${pendingToolCall.event.id}:${entry.event.id}`,
              call: pendingToolCall.event,
              result: entry.event,
              mode,
            }
          }
          continue
        }
      }
      items.push({ type: "event", event: entry.event, mode: eventMode })
      continue
    }
    if (entry.message.role === "user") {
      activeMode = entry.message.mode ?? activeMode
    }
    appendDisplayMessage(items, entry.message, entry.message.mode ?? activeMode)
  }
  return items
}

function isBashToolEvent(event: TimelineEvent) {
  const toolName = compactToolName(stringPayload(event.payload.toolName))
    .toLowerCase()
    .trim()
  return (
    toolName === "exec_command" || toolName === "bash" || toolName === "shell"
  )
}

function timelineEventMode(event: TimelineEvent): SessionMode | undefined {
  const mode = stringPayload(event.payload.mode)
  if (mode === "ask" || mode === "plan" || mode === "act") {
    return mode
  }
  return undefined
}

function findPendingToolCallIndex(
  items: TimelineItem[],
  result: TimelineEvent
) {
  if (result.kind !== "tool_result") {
    return -1
  }
  const resultTool = stringPayload(result.payload.toolName)
  if (resultTool === "") {
    return -1
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item.type === "event" &&
      item.event.kind === "tool_call" &&
      stringPayload(item.event.payload.toolName) === resultTool
    ) {
      return index
    }
  }
  return -1
}

function appendDisplayMessage(
  items: TimelineItem[],
  message: Message,
  mode?: SessionMode
) {
  if (message.role !== "system") {
    items.push({ type: "message", message, mode })
    return
  }

  const parsed = parseSystemMessage(message.content)
  if (parsed.groupKind === "other") {
    items.push({ type: "message", message, mode })
    return
  }

  const previous = items[items.length - 1]
  if (
    previous?.type === "system-group" &&
    canAppendToSystemGroup(previous.messages, message, parsed.groupKind)
  ) {
    previous.messages.push(message)
    previous.mode = previous.mode ?? mode
    return
  }

  items.push({
    type: "system-group",
    id: message.id,
    messages: [message],
    mode,
  })
}

function canAppendToSystemGroup(
  messages: Message[],
  nextMessage: Message,
  nextGroupKind: "thinking" | "tool"
) {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) {
    return false
  }

  const lastGroupKind = parseSystemMessage(lastMessage.content).groupKind
  return lastGroupKind === nextGroupKind && nextMessage.role === "system"
}

function summarizeThinkingGroup(
  parsedMessages: Array<{
    message: Message
    parsed: ReturnType<typeof parseSystemMessage>
  }>
) {
  const summaries = parsedMessages
    .map(({ parsed }) => compactThinkingText(parsed.summary))
    .filter(Boolean)
    .slice(0, 2)

  if (summaries.length === 0) {
    return parsedMessages.length > 1
      ? `${parsedMessages.length} thinking steps`
      : ""
  }

  const summary = summaries.join(" • ")
  return parsedMessages.length > 2 ? `${summary}...` : summary
}

function summarizeToolGroup(
  parsedMessages: Array<{
    message: Message
    parsed: ReturnType<typeof parseSystemMessage>
  }>
) {
  const started = parsedMessages.filter(
    ({ parsed }) => parsed.title === "Tool started"
  )
  const toolNames = Array.from(
    new Set(
      started
        .map(({ parsed }) =>
          parsed.detail
            .split("\n")[0]
            ?.trim()
            .replace(/^Using\s+/i, "")
        )
        .filter(Boolean)
    )
  )

  if (toolNames.length === 0) {
    return {
      isBash: false,
      label:
        parsedMessages.length > 1
          ? `${parsedMessages.length} tool events`
          : "Tool activity",
    }
  }

  const isBash = toolNames.every((name) => {
    const normalized = compactToolName(name).toLowerCase()
    return (
      normalized === "exec_command" ||
      normalized === "bash" ||
      normalized === "shell"
    )
  })
  const namesLabel = compactText(toolNames.join(", "))
  return {
    isBash,
    label: isBash
      ? `${Math.ceil(parsedMessages.length / 2)} command${parsedMessages.length > 2 ? "s" : ""}`
      : parsedMessages.length > toolNames.length
        ? `${namesLabel} (${parsedMessages.length} events)`
        : namesLabel,
  }
}

type ToolEventDisplay = {
  toolLabel: string
  status: "started" | "succeeded" | "failed" | "finished"
  statusLabel: string
  summary: string
  meta: Array<{ label: string; value: string }>
  detail: string
  isPatch: boolean
}

function parseToolEvent(title: string, detail: string): ToolEventDisplay {
  const [firstLine = "", ...detailLines] = detail.split("\n")
  const body = detailLines.join("\n").trim()

  if (title === "Tool started") {
    const toolName = firstLine.replace(/^Using\s+/i, "").trim() || "Tool"
    return buildToolEventDisplay(toolName, body, "started")
  }

  const resultMatch = firstLine.match(/^(.+?)\s+(succeeded|failed)$/i)
  const toolName = (resultMatch?.[1] ?? firstLine).trim() || "Tool"
  const status =
    resultMatch?.[2]?.toLowerCase() === "failed" ? "failed" : "succeeded"
  return buildToolEventDisplay(toolName, body, status)
}

function buildToolEventDisplay(
  toolName: string,
  body: string,
  status: ToolEventDisplay["status"]
): ToolEventDisplay {
  const toolLabel = compactToolName(toolName)
  const statusLabel =
    status === "started" ? "Running" : status === "failed" ? "Failed" : "Done"
  const parsedInput = parseToolInput(body)
  const patchFiles = extractPatchFiles(body)
  const isPatch = patchFiles.length > 0 || body.startsWith("*** Begin Patch")

  if (toolLabel === "exec_command" && parsedInput) {
    const command = stringValue(parsedInput.cmd)
    const workdir = stringValue(parsedInput.workdir)
    return {
      toolLabel,
      status,
      statusLabel,
      summary: command ? compactText(command) : "",
      meta: workdir ? [{ label: "cwd", value: workdir }] : [],
      detail: command ? body : prettifyToolBody(body),
      isPatch: false,
    }
  }

  if (isPatch) {
    const visibleFiles = patchFiles.slice(0, 4)
    const hiddenFileCount = patchFiles.length - visibleFiles.length
    return {
      toolLabel,
      status,
      statusLabel,
      summary:
        patchFiles.length > 0
          ? `${patchFiles.length} file${patchFiles.length === 1 ? "" : "s"} changed`
          : "Patch",
      meta: [
        ...visibleFiles.map((file) => ({ label: "file", value: file })),
        ...(hiddenFileCount > 0
          ? [{ label: "more", value: `+${hiddenFileCount}` }]
          : []),
      ],
      detail: body,
      isPatch: true,
    }
  }

  return {
    toolLabel,
    status,
    statusLabel,
    summary: parsedInput ? summarizeToolInput(parsedInput) : compactText(body),
    meta: [],
    detail: prettifyToolBody(body),
    isPatch: false,
  }
}

function compactToolName(value: string) {
  const normalized = value.trim()
  return normalized.split(".").filter(Boolean).at(-1) ?? normalized
}

function parseToolInput(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function summarizeToolInput(input: Record<string, unknown>) {
  const preferred = ["cmd", "path", "ref_id", "pattern", "target"]
  for (const key of preferred) {
    const value = stringValue(input[key])
    if (value) {
      return compactText(value)
    }
  }
  return compactText(JSON.stringify(input))
}

function prettifyToolBody(value: string) {
  const parsed = parseToolInput(value)
  if (!parsed) {
    return value
  }
  return JSON.stringify(parsed, null, 2)
}

function extractPatchFiles(value: string) {
  const files: string[] = []
  for (const line of value.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (match?.[1]) {
      files.push(match[1])
    }
  }
  return Array.from(new Set(files))
}

function DiffLines({
  content,
  files = [],
}: {
  content: string
  files?: string[]
}) {
  const languageByPath = new Map(
    files.map((path) => [path, inferPrismLanguage(path)])
  )
  let currentLanguage: string | undefined

  return (
    <code className="block">
      {content.split("\n").map((line, index) => {
        const nextPath = diffLinePath(line)
        if (nextPath) {
          currentLanguage =
            languageByPath.get(nextPath) ?? inferPrismLanguage(nextPath)
        }
        return <DiffLine key={index} line={line} language={currentLanguage} />
      })}
    </code>
  )
}

function looksLikeDiff(content: string) {
  const lines = content.split("\n")
  return (
    lines.some((line) => line.startsWith("diff --git ")) ||
    lines.some((line) => line.startsWith("*** Begin Patch")) ||
    (lines.some((line) => line.startsWith("@@")) &&
      lines.some((line) => line.startsWith("+")) &&
      lines.some((line) => line.startsWith("-")))
  )
}

function DiffLine({ line, language }: { line: string; language?: string }) {
  if (line.startsWith("@@") || line.startsWith("***")) {
    return (
      <span className="block bg-muted px-1 whitespace-pre text-muted-foreground">
        {line || " "}
      </span>
    )
  }

  return (
    <span
      className={cn(
        "block whitespace-pre",
        line.startsWith("+") && "bg-primary/10 text-primary",
        line.startsWith("-") && "bg-destructive/10 text-destructive"
      )}
    >
      <HighlightedDiffLine line={line} language={language} />
    </span>
  )
}

function HighlightedDiffLine({
  line,
  language,
}: {
  line: string
  language?: string
}) {
  if (!line) {
    return <> </>
  }
  const marker = line[0]
  if (marker !== "+" && marker !== "-" && marker !== " ") {
    return <>{line}</>
  }
  const code = line.slice(1)
  return (
    <>
      {marker}
      <PrismCode code={code} language={language} />
    </>
  )
}

function PrismCode({ code, language }: { code: string; language?: string }) {
  const prismLanguage = normalizePrismLanguage(language)
  const grammar = prismLanguage ? Prism.languages[prismLanguage] : undefined
  if (!grammar) {
    return <>{code || " "}</>
  }
  const tokens = Prism.tokenize(code, grammar)
  return <>{tokens.map((token, index) => renderPrismToken(token, index))}</>
}

function renderPrismToken(
  token: string | Prism.Token,
  index: number
): React.ReactNode {
  if (typeof token === "string") {
    return <React.Fragment key={index}>{token}</React.Fragment>
  }
  const content = Array.isArray(token.content)
    ? token.content.map((child, childIndex) =>
        renderPrismToken(child, childIndex)
      )
    : typeof token.content === "string"
      ? token.content
      : renderPrismToken(token.content, 0)
  return (
    <span key={index} className={prismTokenClassName(token.type)}>
      {content}
    </span>
  )
}

function prismTokenClassName(type: string) {
  switch (type) {
    case "atrule":
    case "keyword":
      return "font-semibold text-fuchsia-700 dark:text-fuchsia-300"
    case "attr-name":
    case "property":
      return "text-blue-700 dark:text-blue-300"
    case "boolean":
    case "number":
      return "text-amber-700 dark:text-amber-300"
    case "builtin":
    case "class-name":
    case "function":
      return "text-violet-700 dark:text-violet-300"
    case "comment":
      return "text-muted-foreground"
    case "inserted":
    case "string":
      return "text-teal-700 dark:text-teal-300"
    case "deleted":
    case "tag":
      return "text-rose-700 dark:text-rose-300"
    case "operator":
    case "punctuation":
      return "text-foreground/70"
    default:
      return ""
  }
}

function diffLinePath(line: string) {
  if (!line.startsWith("diff --git ")) {
    return null
  }
  const parts = line.split(/\s+/)
  const path = parts[3]?.replace(/^b\//, "") ?? ""
  return path || null
}

function inferPrismLanguage(path: string, code = "") {
  const normalized = path.toLowerCase()
  const fileName = normalized.split("/").pop() ?? normalized
  const extension = fileName.match(/\.[^.]+$/)?.[0] ?? ""

  if (/^\s*[{\[]/.test(code)) {
    return "json"
  }
  if (/^\s*(?:#|npm |pnpm |yarn |git |go test|cargo |cd |export )/.test(code)) {
    return "bash"
  }

  if (fileName === "dockerfile" || fileName === "makefile") {
    return "bash"
  }
  if (fileName === "go.mod" || fileName === "go.sum") {
    return "go"
  }

  switch (extension) {
    case ".bash":
    case ".sh":
    case ".zsh":
      return "bash"
    case ".css":
    case ".scss":
      return "css"
    case ".go":
      return "go"
    case ".html":
    case ".vue":
    case ".svelte":
      return "markup"
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "jsx"
    case ".json":
    case ".jsonc":
      return "json"
    case ".md":
    case ".mdx":
      return "markdown"
    case ".py":
      return "python"
    case ".rb":
      return "ruby"
    case ".rs":
      return "rust"
    case ".sql":
      return "sql"
    case ".toml":
      return "toml"
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".yaml":
    case ".yml":
      return "yaml"
    default:
      return undefined
  }
}

function normalizePrismLanguage(language: string | undefined) {
  if (!language) {
    return undefined
  }
  if (language === "shell" || language === "sh" || language === "zsh") {
    return "bash"
  }
  if (language === "html") {
    return "markup"
  }
  return language
}

function ChangePreview({
  messages,
  compact = false,
}: {
  messages: Message[]
  compact?: boolean
}) {
  const diffBlocks = React.useMemo(
    () => extractDiffBlocks(messages),
    [messages]
  )

  if (diffBlocks.length === 0) {
    return null
  }

  return (
    <Card
      className={compact ? "w-full min-w-0 max-w-full overflow-hidden" : "mr-auto w-full min-w-0 max-w-[92%] overflow-hidden"}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileCodeIcon data-icon="inline-start" />
          Change preview
        </CardTitle>
        <CardDescription>
          Highlighted diff blocks detected in the conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {diffBlocks.map((diff, index) => (
          <pre
            key={index}
            className="max-w-full rounded-md border bg-background p-3 text-xs"
          >
            <DiffLines content={diff} />
          </pre>
        ))}
      </CardContent>
    </Card>
  )
}

function extractDiffBlocks(messages: Message[]) {
  return messages.flatMap((message) =>
    Array.from(message.content.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g))
      .map((match) => ({
        language: match[1]?.trim().toLowerCase() ?? "",
        content: match[2] ?? "",
      }))
      .filter(
        (block) => block.language === "diff" || looksLikeDiff(block.content)
      )
      .map((block) => block.content)
  )
}

function useRunningDuration(session: Session | null) {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!session || session.status !== "running") {
      return
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(intervalId)
  }, [session])

  if (!session) {
    return "0s"
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - (parseDateTimeMillis(session.updatedAt) ?? now)) / 1000)
  )
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function isLikelyTimedOut(session: Session, runningDuration: string) {
  if (session.status !== "running") {
    return false
  }
  const minutes = Number.parseInt(runningDuration.split("m")[0] ?? "0", 10)
  return runningDuration.includes("m") && minutes >= 10
}

function ModeSelect({
  value,
  onValueChange,
  disabled,
}: {
  value: SessionMode
  onValueChange: (mode: SessionMode) => void
  disabled?: boolean
}) {
  if (disabled) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn(
          "min-w-[5.75rem] justify-start sm:w-36",
          modeColorClassName(value)
        )}
        disabled
      >
        {modeIcon(value)}
        <span>{modeLabel(value)}</span>
      </Button>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as SessionMode)}
    >
      <SelectTrigger
        className={cn(
          "min-w-[5.75rem] shrink-0 sm:w-36",
          modeColorClassName(value)
        )}
        size="sm"
        aria-label="Session mode"
      >
        <SelectValue>
          <span className="inline-flex min-w-0 items-center gap-1">
            {modeIcon(value)}
            <span>{modeLabel(value)}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {(["ask", "plan", "act"] as const).map((mode) => (
            <SelectItem key={mode} value={mode}>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
                  modeColorClassName(mode)
                )}
              >
                {modeIcon(mode)}
                {modeLabel(mode)}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function modePlaceholder(mode: SessionMode) {
  if (mode === "plan") {
    return "Ask the agent to make or revise a plan"
  }
  if (mode === "act") {
    return "Ask the agent to edit, verify, or commit"
  }
  return "Ask about the workspace or next steps"
}

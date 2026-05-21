/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  BrainIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  ClockCountdownIcon,
  CopyIcon,
  DotsThreeOutlineIcon,
  FileCodeIcon,
  GitBranchIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  PipeWrenchIcon,
  PlusIcon,
  QuotesIcon,
  ShieldWarningIcon,
  StopIcon,
  TerminalIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { GitPanel } from "@/components/git/git-panel"
import { SessionGitPanel } from "@/components/git/session-git-panel"
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
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
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
  cancelSession as cancelStoredSession,
  refreshSession as refreshStoredSession,
  respondPermission as respondStoredPermission,
  sendMessage as sendStoredMessage,
  updateMode as updateStoredMode,
  updateModel as updateStoredModel,
  updateSession as updateStoredSession,
  useSessionStore,
} from "@/lib/session-store"
import { cn } from "@/lib/utils"
import type { AppConfig, Message, ProjectDetail, Session, SessionMode } from "@/types/domain"

function modeIcon(mode: SessionMode) {
  if (mode === "plan") {
    return <CheckCircleIcon data-icon="inline-start" />
  }
  if (mode === "act") {
    return <FileCodeIcon data-icon="inline-start" />
  }
  return <ChatCircleTextIcon data-icon="inline-start" />
}

export function SessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { details } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [appConfig, setAppConfig] = React.useState<AppConfig | null>(null)
  const [input, setInput] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSending, setIsSending] = React.useState(false)
  const [isCanceling, setIsCanceling] = React.useState(false)
  const [isClearingContext, setIsClearingContext] = React.useState(false)
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [isRenameDialogOpen, setIsRenameDialogOpen] = React.useState(false)
  const [renameTitle, setRenameTitle] = React.useState("")
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  const [pendingPermissionId, setPendingPermissionId] = React.useState<string | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null)
  const endOfMessagesRef = React.useRef<HTMLDivElement | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const session = React.useMemo(
    () => (sessionId ? details.get(sessionId) ?? null : null),
    [details, sessionId]
  )
  const lastUserMessage = React.useMemo(
    () => [...(session?.messages ?? [])].reverse().find((message) => message.role === "user"),
    [session?.messages]
  )
  const displayMessages = React.useMemo(
    () => buildDisplayMessages(session?.messages ?? []),
    [session?.messages]
  )
  const runningDuration = useRunningDuration(session)
  const draftStorageKey = sessionId ? `coding-broker:draft:${sessionId}` : null

  const loadSession = React.useCallback(async () => {
    if (!sessionId) {
      return
    }

    setIsLoading(true)
    const [nextSession, nextProjects, nextConfig] = await Promise.all([
      refreshStoredSession(sessionId),
      api.projects(),
      api.config(),
    ])
    setProjects(nextProjects)
    setAppConfig(nextConfig)
    setErrorMessage(null)

    if (nextSession.projectSlug) {
      setProject(await api.project(nextSession.projectSlug))
    } else {
      setProject(null)
    }

    setIsLoading(false)
  }, [sessionId])

  const handleMissingSession = React.useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      toast.error("Session no longer exists")
      navigate("/workspace")
      return true
    }
    return false
  }, [navigate])

  React.useEffect(() => {
    loadSession().catch((error: unknown) => {
      setIsLoading(false)
      if (handleMissingSession(error)) {
        return
      }
      setErrorMessage(error instanceof Error ? error.message : "Session unavailable")
    })
  }, [handleMissingSession, loadSession])

  React.useEffect(() => {
    if (!draftStorageKey) {
      return
    }

    setInput(localStorage.getItem(draftStorageKey) ?? "")
  }, [draftStorageKey])

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
    if (!sessionId || !session) {
      return
    }
    setErrorMessage(null)
  }, [session, sessionId])

  React.useEffect(() => {
    if (isAtBottom) {
      scrollToBottom("smooth")
    }
  }, [isAtBottom, session?.messages?.length, session?.status])

  React.useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) {
      return
    }

    const handleScroll = () => {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      setIsAtBottom(distanceFromBottom < 80)
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
      toast.error(error instanceof Error ? error.message : "Could not switch mode")
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
      toast.error(error instanceof Error ? error.message : "Could not switch model")
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
      toast.error(error instanceof Error ? error.message : "Could not rename session")
    } finally {
      setIsRenaming(false)
    }
  }

  async function clearSessionContext() {
    if (!session || !session.worktreeId) {
      return
    }

    setIsClearingContext(true)
    try {
      await updateStoredSession(session.id, { worktreeId: "" })
      await refreshStoredSession(session.id)
      toast.success("Session context cleared")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(error instanceof Error ? error.message : "Could not clear session context")
    } finally {
      setIsClearingContext(false)
    }
  }

  async function sendMessage() {
    if (
      !session ||
      !input.trim() ||
      session.status === "running"
    ) {
      return
    }

    setIsSending(true)
    try {
      await sendStoredMessage(session.id, { content: input.trim() })
      setInput("")
      if (draftStorageKey) {
        localStorage.removeItem(draftStorageKey)
      }
      setIsAtBottom(true)
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(error instanceof Error ? error.message : "Could not send message")
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
        content: lastUserMessage.content,
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
      toast.error(error instanceof Error ? error.message : "Could not cancel run")
    } finally {
      setIsCanceling(false)
      setIsSending(false)
    }
  }

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    endOfMessagesRef.current?.scrollIntoView({ behavior, block: "end" })
  }

  function quoteMessage(message: Message) {
    const quote = message.content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    setInput((current) => (current.trim() ? `${current.trim()}\n\n${quote}\n` : `${quote}\n`))
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

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) {
      return
    }

    event.preventDefault()
    void sendMessage()
  }

  async function respondPermission(permissionId: string, decision: "allow" | "deny") {
    if (!session) {
      return
    }

    setPendingPermissionId(permissionId)
    try {
      await respondStoredPermission(session.id, permissionId, decision)
      toast.success(decision === "allow" ? "Permission allowed" : "Permission denied")
    } catch (error) {
      if (handleMissingSession(error)) {
        return
      }
      toast.error(error instanceof Error ? error.message : "Could not respond to permission")
    } finally {
      setPendingPermissionId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="min-h-96 flex-1 w-full" />
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
              {errorMessage ?? "This in-memory demo session is no longer available."}
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
  const contextLabel = session.worktree ? "Worktree context" : "Workspace context"
  const contextName = session.worktree?.name ?? selectedProject?.name ?? null
  const missingContextLabel = session.worktree ? "Missing worktree" : "Missing workspace"
  const contextPath = session.worktree?.path ?? selectedProject?.path
  const projectContextText = contextPath
    ? `${contextLabel}: ${contextPath}`
    : "Workspace context is missing. Start a new session from the workspace switcher."

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b p-4 lg:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-lg font-medium">{session.title}</h1>
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
                  <Button variant="ghost" size="icon" aria-label="Rename session">
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
                      <Button type="submit" disabled={isRenaming || !renameTitle.trim()}>
                        {isRenaming ? "Saving" : "Save"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
              <StatusBadge value={session.status} />
              {session.status === "running" ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <ClockCountdownIcon data-icon="inline-start" />
                  {runningDuration}
                </span>
              ) : null}
            </div>
            <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
              {projectContextText}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <ProjectContextBadge
              contextName={contextName}
              missingLabel={missingContextLabel}
              className="hidden sm:flex"
            />
            {session.worktreeId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={clearSessionContext}
                disabled={isClearingContext}
              >
                <XIcon data-icon="inline-start" />
                Clear context
              </Button>
            ) : null}
            {(session.status === "failed" || isLikelyTimedOut(session, runningDuration)) && lastUserMessage ? (
              <Button variant="outline" size="sm" onClick={retryLastMessage} disabled={isSending}>
                <ArrowClockwiseIcon data-icon="inline-start" />
                Retry
              </Button>
            ) : null}
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="xl:hidden">
                  <DotsThreeOutlineIcon data-icon="inline-start" className="sm:hidden" />
                  <GitBranchIcon data-icon="inline-start" className="hidden sm:block" />
                  <span className="sm:hidden">Details</span>
                  <span className="hidden sm:inline">Workspace Git</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[92vw] overflow-auto sm:w-[32rem]">
                <SheetHeader>
                  <SheetTitle>Session details</SheetTitle>
                </SheetHeader>
                <div className="flex flex-col gap-4 px-4 pb-4">
                  <div className="space-y-2 rounded-xl border p-3">
                    <div className="text-sm font-medium">{contextLabel}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ProjectContextBadge
                        contextName={contextName}
                        missingLabel={missingContextLabel}
                        compact
                      />
                      {session.worktreeId ? (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={clearSessionContext}
                          disabled={isClearingContext}
                        >
                          <XIcon data-icon="inline-start" />
                          Clear
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">{projectContextText}</p>
                  </div>
                  {session && (
                    <SessionGitPanel
                      session={session}
                      onSessionChange={() => refreshStoredSession(session.id)}
                    />
                  )}
                  <div className="space-y-2 rounded-xl border p-3">
                    <div className="text-sm font-medium">Workspace Git</div>
                    <p className="text-sm text-muted-foreground">
                      Review branch status and recent changes for this workspace.
                    </p>
                  </div>
                  <GitPanel project={project} onProjectChange={setProject} />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-h-0 min-w-0">
          <div className="relative mx-auto grid h-full w-full max-w-3xl min-w-0 grid-rows-[minmax(0,1fr)_auto] px-4 pt-4 xl:px-6 xl:pt-6">
            <div ref={scrollContainerRef} className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
              <div className="flex min-w-0 flex-col gap-3 px-1 pb-4">
                <PermissionPanel
                  session={session}
                  pendingPermissionId={pendingPermissionId}
                  onRespond={respondPermission}
                />
                {session.messages.length === 0 ? (
                  <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                    <ChatCircleTextIcon />
                    <div className="text-sm font-medium">Start the conversation</div>
                    <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                      The mode selector changes how this session responds; the thread stays in one place.
                    </p>
                  </div>
                ) : (
                  <>
                    {displayMessages.map((item) =>
                      item.type === "message" ? (
                        <MessageBubble
                          key={item.message.id}
                          message={item.message}
                          onCopy={copyMessage}
                          onQuote={quoteMessage}
                        />
                      ) : (
                        <SystemMessageGroupBubble key={item.id} messages={item.messages} />
                      )
                    )}
                    <ChangePreview messages={session.messages} />
                  </>
                )}
                <div ref={endOfMessagesRef} />
              </div>
            </div>
            {!isAtBottom ? (
              <Button
                variant="outline"
                size="sm"
                className="absolute bottom-36 left-1/2 z-10 -translate-x-1/2"
                onClick={() => {
                  setIsAtBottom(true)
                  scrollToBottom("smooth")
                }}
              >
                <ArrowDownIcon data-icon="inline-start" />
                Latest
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
              isAgentBusy={isAgentBusy}
              isCanceling={isCanceling}
              availableModels={appConfig?.availableModels ?? []}
              selectedModel={session.model || appConfig?.defaultModel || ""}
            />
          </div>
        </section>

        <aside className="hidden min-h-0 flex-col gap-4 border-l p-4 xl:flex">
          {session && (
            <SessionGitPanel
              session={session}
              onSessionChange={() => refreshStoredSession(session.id)}
            />
          )}
          <ModeContext session={session} />
          <ChangePreview messages={session.messages} compact />
          <GitPanel project={project} onProjectChange={setProject} />
        </aside>
      </div>
    </div>
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
  availableModels: string[]
  selectedModel: string
}) {
  return (
    <div className="shrink-0 bg-background pt-3 pb-3 lg:pb-4">
      <div className="flex w-full flex-col gap-2 rounded-lg border bg-card p-2 text-card-foreground shadow-sm">
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={modePlaceholder(session.mode)}
          disabled={isAgentBusy}
          className="max-h-28 min-h-12 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus-visible:ring-0"
        />
        <Separator />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 sm:flex-row sm:items-center">
            <ModeSelect value={session.mode} onValueChange={onModeChange} disabled={isAgentBusy} />
            <ModelSelect
              models={availableModels}
              value={selectedModel}
              onValueChange={onModelChange}
              disabled={isAgentBusy}
              className="min-w-0 flex-1 sm:w-44 sm:flex-none"
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="hidden whitespace-nowrap text-xs text-muted-foreground lg:inline">
              Enter to send, Shift+Enter for newline
            </span>
            {lastUserMessage && !input.trim() ? (
              <Button variant="ghost" size="sm" onClick={() => onQuote(lastUserMessage)} disabled={isAgentBusy}>
                <QuotesIcon data-icon="inline-start" />
                Reuse
              </Button>
            ) : null}
            {isAgentBusy ? (
              <Button variant="outline" size="sm" onClick={onCancel} disabled={isCanceling}>
                <StopIcon data-icon="inline-start" />
                {isCanceling ? "Canceling" : "Cancel"}
              </Button>
            ) : (
              <Button size="sm" onClick={onSend} disabled={isSending || !input.trim()}>
                <PaperPlaneTiltIcon data-icon="inline-start" />
                {isSending ? "Sending" : "Send"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
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
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="text-sm font-medium">Permission required</div>
      {pendingPermissions.map((permission) => (
        <div key={permission.id} className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <div className="text-xs font-medium">{permission.toolName || "Tool request"}</div>
          <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
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
  onCopy,
  onQuote,
}: {
  message: Message
  onCopy: (message: Message) => void
  onQuote: (message: Message) => void
}) {
  if (message.role === "system") {
    const systemMessage = parseSystemMessage(message.content)
    const messageTime = formatPreciseDateTime(message.createdAt)

    if (systemMessage.isCollapsible) {
      return (
        <details
          className="group mr-auto max-w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]"
          title={messageTime}
        >
          <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
            <span className="flex min-w-0 items-start gap-2 break-words">
              <SystemMessageIcon title={systemMessage.title} />
              <span className="min-w-0">
                <span className="mr-1 font-medium text-foreground">{systemMessage.label}</span>
                {systemMessage.summary}
              </span>
            </span>
            <span className="flex w-12 shrink-0 items-center justify-end gap-2 text-muted-foreground">
              <span className="group-open:hidden">Show</span>
              <span className="hidden group-open:inline">Hide</span>
            </span>
          </summary>
          {systemMessage.detail ? (
            <pre className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words border-t pt-2 text-xs text-muted-foreground">
              {systemMessage.detail}
            </pre>
          ) : null}
        </details>
      )
    }

    return (
      <div
        className="group mr-auto max-w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground shadow-sm sm:max-w-[92%]"
        title={messageTime}
      >
        <div className="flex items-start gap-2">
          <SystemMessageIcon title={systemMessage.title} />
          <span className="min-w-0">{message.content}</span>
        </div>
        <div className="mt-1 hidden text-xs text-muted-foreground group-hover:block">
          {messageTime}
        </div>
      </div>
    )
  }

  const messageTime = formatPreciseDateTime(message.createdAt)

  return (
    <div className={cn("group flex flex-col gap-1", message.role === "user" ? "items-end" : "items-start")}>
      <div
        className={cn(
          message.role === "user"
            ? "max-w-[88%] rounded-lg bg-primary p-3 text-sm whitespace-pre-wrap break-words text-primary-foreground sm:max-w-[82%]"
            : "max-w-[88%] rounded-lg bg-muted p-3 text-sm break-words sm:max-w-[82%]"
        )}
      >
        <RichMessageContent content={message.content} isUser={message.role === "user"} />
      </div>
      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
        <span className="px-1 text-xs text-muted-foreground">{messageTime}</span>
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

function SystemMessageGroupBubble({ messages }: { messages: Message[] }) {
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
    return (
      <details
        className="group mr-auto max-w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]"
        title={timeLabel}
      >
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <TerminalIcon className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="mr-1 font-medium text-foreground">Tool call</span>
              {summarizeToolGroup(parsedMessages)}
            </span>
          </span>
            <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
              {countLabel ? <span>{countLabel}</span> : null}
              <SystemMessageGroupMeta timeLabel={timeLabel} />
            </span>
        </summary>
	        <div className="mt-2 flex flex-col gap-2 border-t pt-2">
	          {parsedMessages.map(({ message, parsed }) => (
	            <div key={message.id} className="rounded-md border bg-muted/30 px-2 py-1.5" title={formatPreciseDateTime(message.createdAt)}>
	              <div className="flex items-start justify-between gap-2">
	                <div className="flex min-w-0 items-start gap-2">
	                  <SystemMessageIcon title={parsed.title} />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">
                      {parsed.label}
                      {parsed.summary ? `: ${parsed.summary}` : ""}
                    </div>
	                  </div>
	                </div>
	              </div>
              {parsed.detail ? (
                <pre className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                  {parsed.detail}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </details>
    )
  }

  return (
    <details
      className="group mr-auto max-w-full rounded-lg border bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-sm sm:max-w-[92%]"
      title={timeLabel}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-3 font-medium text-foreground/80 marker:content-none">
        <span className="flex min-w-0 items-start gap-2 break-words">
          <SystemMessageIcon title={firstParsed.title} />
          <span className="min-w-0">
            <span className="mr-1 font-medium text-foreground">{firstParsed.label}</span>
            {summarizeThinkingGroup(parsedMessages)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {countLabel ? <span>{countLabel}</span> : null}
          <SystemMessageGroupMeta timeLabel={timeLabel} />
        </span>
      </summary>
	      <div className="mt-2 flex flex-col gap-2 border-t pt-2">
	        {parsedMessages.map(({ message, parsed }) => (
	          <div key={message.id} className="rounded-md border bg-muted/30 px-2 py-1.5" title={formatPreciseDateTime(message.createdAt)}>
	            <div className="flex items-start justify-between gap-2">
	              <div className="flex min-w-0 items-start gap-2">
	                <SystemMessageIcon title={parsed.title} />
	                <div className="min-w-0 font-medium text-foreground">
	                  {parsed.summary || parsed.label}
	                </div>
	              </div>
	            </div>
            {parsed.detail ? (
              <pre className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                {parsed.detail}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  )
}

function SystemMessageGroupMeta({ timeLabel }: { timeLabel: string }) {
  return (
    <span className="inline-flex w-9 shrink-0 justify-end text-right" title={timeLabel}>
      <span className="group-open:hidden">
        Show
      </span>
      <span className="hidden group-open:inline">
        Hide
      </span>
    </span>
  )
}

function RichMessageContent({
  content,
  isUser,
}: {
  content: string
  isUser: boolean
}) {
  const blocks = parseMarkdownBlocks(content)

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          const isDiff = block.language === "diff" || looksLikeDiff(block.content)

          return (
            <pre
              key={`${block.type}-${index}`}
              className={cn(
                "max-w-full overflow-auto rounded-md border p-3 text-xs leading-relaxed",
                isUser ? "border-primary-foreground/30" : "bg-background"
              )}
            >
              {isDiff ? (
                <DiffLines content={block.content} />
              ) : (
                <code>{block.content}</code>
              )}
            </pre>
          )
        }

        return (
          <div key={`${block.type}-${index}`} className="whitespace-pre-wrap leading-relaxed">
            {renderInlineCode(block.content)}
          </div>
        )
      })}
    </div>
  )
}

function renderInlineCode(content: string) {
  const parts = content.split(/(`[^`]+`)/g)

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-background/70 px-1 py-0.5 text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      )
    }

    return <React.Fragment key={index}>{part}</React.Fragment>
  })
}

function parseSystemMessage(content: string) {
  const [title = "Agent event", ...detailLines] = content.split("\n")
  const detail = detailLines.join("\n").trim()
  const isCollapsible =
    title === "Thinking" || title === "Tool started" || title === "Tool finished"

  return {
    title,
    detail,
    isCollapsible,
    label: systemMessageLabel(title),
    summary: summarizeSystemMessage(title, detail),
    groupKind: systemMessageGroupKind(title),
  }
}

function SystemMessageIcon({ title }: { title: string }) {
  if (title === "Thinking") {
    return <BrainIcon className="mt-0.5 shrink-0 text-primary" />
  }
  if (title === "Tool started") {
    return <TerminalIcon className="mt-0.5 shrink-0 text-muted-foreground" />
  }
  if (title === "Tool finished") {
    return <PipeWrenchIcon className="mt-0.5 shrink-0 text-primary" />
  }
  if (title === "Permission requested") {
    return <ShieldWarningIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  if (title === "Agent error") {
    return <WarningCircleIcon className="mt-0.5 shrink-0 text-destructive" />
  }
  return <ChatCircleTextIcon className="mt-0.5 shrink-0 text-muted-foreground" />
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
  const detailLines = detail.split("\n").map((line) => line.trim()).filter(Boolean)
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

type DisplayMessageItem =
  | { type: "message"; message: Message }
  | { type: "system-group"; id: string; messages: Message[] }

function buildDisplayMessages(messages: Message[]): DisplayMessageItem[] {
  const items: DisplayMessageItem[] = []

  for (const message of messages) {
    if (message.role !== "system") {
      items.push({ type: "message", message })
      continue
    }

    const parsed = parseSystemMessage(message.content)
    if (parsed.groupKind === "other") {
      items.push({ type: "message", message })
      continue
    }

    const previous = items[items.length - 1]
    if (
      previous?.type === "system-group" &&
      canAppendToSystemGroup(previous.messages, message, parsed.groupKind)
    ) {
      previous.messages.push(message)
      continue
    }

    items.push({ type: "system-group", id: message.id, messages: [message] })
  }

  return items
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
  parsedMessages: Array<{ message: Message; parsed: ReturnType<typeof parseSystemMessage> }>
) {
  const summaries = parsedMessages
    .map(({ parsed }) => parsed.summary)
    .filter(Boolean)
    .slice(0, 2)

  if (summaries.length === 0) {
    return parsedMessages.length > 1 ? `${parsedMessages.length} thinking steps` : ""
  }

  const summary = summaries.join(" • ")
  return parsedMessages.length > 2 ? `${summary} ...` : summary
}

function summarizeToolGroup(
  parsedMessages: Array<{ message: Message; parsed: ReturnType<typeof parseSystemMessage> }>
) {
  const started = parsedMessages.filter(({ parsed }) => parsed.title === "Tool started")
  const toolNames = Array.from(
    new Set(
      started
        .map(({ parsed }) => parsed.detail.split("\n")[0]?.trim().replace(/^Using\s+/i, ""))
        .filter(Boolean)
    )
  )

  if (toolNames.length === 0) {
    return parsedMessages.length > 1 ? `${parsedMessages.length} tool events` : "Tool activity"
  }

  const namesLabel = compactText(toolNames.join(", "))
  return parsedMessages.length > toolNames.length ? `${namesLabel} (${parsedMessages.length} events)` : namesLabel
}

type MarkdownBlock =
  | { type: "text"; content: string }
  | { type: "code"; content: string; language: string }

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = content.split("\n")
  let textLines: string[] = []
  let codeLines: string[] | null = null
  let language = ""

  function flushText() {
    const text = textLines.join("\n").trim()
    if (text) {
      blocks.push({ type: "text", content: text })
    }
    textLines = []
  }

  function flushCode() {
    if (codeLines) {
      blocks.push({ type: "code", content: codeLines.join("\n"), language })
    }
    codeLines = null
    language = ""
  }

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence && codeLines === null) {
      flushText()
      codeLines = []
      language = fence[1] ?? ""
      continue
    }
    if (fence && codeLines !== null) {
      flushCode()
      continue
    }
    if (codeLines !== null) {
      codeLines.push(line)
    } else {
      textLines.push(line)
    }
  }

  if (codeLines !== null) {
    flushCode()
  }
  flushText()

  return blocks.length > 0 ? blocks : [{ type: "text", content }]
}

function looksLikeDiff(content: string) {
  return content
    .split("\n")
    .some((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"))
}

function DiffLines({ content }: { content: string }) {
  return (
    <code className="block">
      {content.split("\n").map((line, index) => (
        <span
          key={index}
          className={cn(
            "block whitespace-pre",
            line.startsWith("+") && "bg-primary/10 text-primary",
            line.startsWith("-") && "bg-destructive/10 text-destructive",
            line.startsWith("@@") && "bg-muted text-muted-foreground"
          )}
        >
          {line || " "}
        </span>
      ))}
    </code>
  )
}

function ChangePreview({
  messages,
  compact = false,
}: {
  messages: Message[]
  compact?: boolean
}) {
  const diffBlocks = React.useMemo(() => extractDiffBlocks(messages), [messages])

  if (diffBlocks.length === 0) {
    return null
  }

  return (
    <Card className={compact ? "" : "mr-auto w-full max-w-[92%]"}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileCodeIcon data-icon="inline-start" />
          Change preview
        </CardTitle>
        <CardDescription>Highlighted diff blocks detected in the conversation.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {diffBlocks.map((diff, index) => (
          <pre key={index} className="max-h-72 overflow-auto rounded-md border bg-background p-3 text-xs">
            <DiffLines content={diff} />
          </pre>
        ))}
      </CardContent>
    </Card>
  )
}

function extractDiffBlocks(messages: Message[]) {
  return messages.flatMap((message) =>
    parseMarkdownBlocks(message.content)
      .filter((block): block is Extract<MarkdownBlock, { type: "code" }> => block.type === "code")
      .filter((block) => block.language === "diff" || looksLikeDiff(block.content))
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
      <Button variant="outline" size="sm" className="w-28 justify-start sm:w-36" disabled>
        {modeIcon(value)}
        <span className="capitalize">{value}</span>
      </Button>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as SessionMode)}
    >
      <SelectTrigger className="w-28 shrink-0 sm:w-36" size="sm" aria-label="Session mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="plan">Plan</SelectItem>
          <SelectItem value="act">Act</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function ProjectContextBadge({
  contextName,
  missingLabel,
  compact = false,
  className,
}: {
  contextName: string | null
  missingLabel: string
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex h-8 max-w-full items-center gap-2 rounded-lg border bg-muted px-2.5 text-sm",
        compact ? "text-xs" : null,
        className
      )}
    >
      <GitBranchIcon data-icon="inline-start" />
      <span className="truncate">{contextName ?? missingLabel}</span>
      {!compact ? <span className="shrink-0 text-xs text-muted-foreground">locked</span> : null}
    </div>
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

function ModeContext({
  session,
}: {
  session: Session
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {modeIcon(session.mode)}
          Mode context
        </CardTitle>
        <CardDescription>
          {session.mode === "ask"
            ? "Ask is read-only exploration and workspace Q&A."
            : session.mode === "plan"
              ? "Plan is read-only implementation planning with files, risks, and checks."
              : "Act can edit files, run verification, and commit when you ask."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {session.mode === "plan" && session.plan.length > 0
          ? session.plan.map((item) => (
              <div key={item.id} className="rounded-lg border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div>
                  </div>
                  <StatusBadge value={item.status} />
                </div>
              </div>
            ))
          : null}
        {session.mode === "act" ? (
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            Act runs in the session worktree. Ask for edits, tests, commits, or Git review directly in the thread.
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

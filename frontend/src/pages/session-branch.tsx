/* eslint-disable react-hooks/set-state-in-effect */
import * as React from "react"
import {
  ArrowLeftIcon,
  FileCodeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { parsePatch, type StructuredPatch } from "diff"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { SessionGitPanel } from "@/components/git/session-git-panel"
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
import { ApiError, api } from "@/lib/api"
import {
  buildBranchDiffDisplay,
  summarizeGitDiff,
  type BranchDiffDisplay,
} from "@/lib/git"
import {
  refreshSession as refreshStoredSession,
  useSessionStore,
} from "@/lib/session-store"
import { cn } from "@/lib/utils"
import type { ProjectDetail } from "@/types/domain"

type SessionGitDiff = {
  diff: string
  type: "empty" | "not_created" | "uncommitted" | "commit"
}

type DiffFile = StructuredPatch & {
  id: string
  path: string
  additions: number
  deletions: number
}

export function SessionBranchPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { details } = useSessionStore()
  const [projects, setProjects] = React.useState<ProjectDetail[]>([])
  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [branchDiffDisplay, setBranchDiffDisplay] =
    React.useState<BranchDiffDisplay | null>(null)
  const [gitDiff, setGitDiff] = React.useState<SessionGitDiff | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const session = React.useMemo(
    () => (sessionId ? (details.get(sessionId) ?? null) : null),
    [details, sessionId]
  )

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

  const loadSession = React.useCallback(async () => {
    if (!sessionId) {
      return
    }

    setIsLoading(true)
    const [nextSession, nextProjects] = await Promise.all([
      refreshStoredSession(sessionId),
      api.projects(),
    ])
    setProjects(nextProjects)
    setErrorMessage(null)

    if (nextSession.projectSlug) {
      setProject(await api.project(nextSession.projectSlug))
    } else {
      setProject(null)
    }

    const diffData = await api.getSessionGitDiff(sessionId)
    setGitDiff(diffData)
    const branchLabel =
      nextSession.worktree?.branch ??
      nextProjects.find(
        (candidate) => candidate.slug === nextSession.projectSlug
      )?.branch ??
      "Current branch"
    setBranchDiffDisplay(
      buildBranchDiffDisplay(branchLabel, summarizeGitDiff(diffData.diff))
    )

    setIsLoading(false)
  }, [sessionId])

  React.useEffect(() => {
    loadSession().catch((error: unknown) => {
      setIsLoading(false)
      if (handleMissingSession(error)) {
        return
      }
      setErrorMessage(
        error instanceof Error ? error.message : "Branch details unavailable"
      )
    })
  }, [handleMissingSession, loadSession])

  React.useEffect(() => {
    if (!sessionId || !session) {
      return
    }
    setErrorMessage(null)
  }, [session, sessionId])

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
            <CardTitle>Branch details unavailable</CardTitle>
            <CardDescription>
              {errorMessage ?? "This session is no longer available."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
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
  const contextPath = session.worktree?.path ?? selectedProject?.path
  const projectContextText = contextPath
    ? contextPath
    : "Workspace context is missing. Start a new session from the workspace switcher."

  return (
    <div className="subtle-scrollbar h-full overflow-y-auto">
      <div className="content-shell flex min-h-full flex-col gap-3 sm:gap-4">
        <header className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm sm:p-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/sessions/${session.id}`}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Chat
                </Link>
              </Button>
              <div className="hidden h-4 w-px bg-border sm:block" />
              <h1 className="min-w-0 flex-1 truncate text-base font-semibold sm:text-lg">
                <BranchDiffLabel
                  branchLabel={
                    branchDiffDisplay?.branchLabel ??
                    session.worktree?.branch ??
                    project?.branch ??
                    selectedProject?.branch ??
                    "Current branch"
                  }
                  additions={branchDiffDisplay?.additions ?? 0}
                  deletions={branchDiffDisplay?.deletions ?? 0}
                />
              </h1>
              <StatusBadge value={session.status} />
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground sm:text-sm">
              {session.title}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground sm:text-sm">
              {projectContextText}
            </p>
          </div>
        </header>

        <SessionGitPanel
          session={session}
          project={project}
          onProjectChange={setProject}
        />
        <BranchFileDiff diffData={gitDiff} />
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
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-top">
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

function BranchFileDiff({ diffData }: { diffData: SessionGitDiff | null }) {
  const files = React.useMemo(
    () => parseDiffFiles(diffData?.diff ?? ""),
    [diffData?.diff]
  )
  const hasChanges = files.length > 0 && diffData?.type !== "empty"

  return (
    <section className="rounded-lg border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileCodeIcon />
            File Diff
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasChanges
              ? `${files.length} file${files.length === 1 ? "" : "s"} changed`
              : diffData?.type === "not_created"
                ? "Workspace has not been created yet."
                : "No file changes available for this branch."}
          </p>
        </div>
        {diffData?.type && diffData.type !== "empty" ? (
          <span className="w-fit rounded-md border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            {formatDiffType(diffData.type)}
          </span>
        ) : null}
      </div>

      {hasChanges ? (
        <div className="subtle-scrollbar flex max-h-[52rem] flex-col overflow-y-auto">
          {files.map((file) => {
            const language = inferCodeLanguage(file.path)

            return (
              <article key={file.id} className="border-b last:border-b-0">
                <div className="flex flex-col gap-2 bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <div className="min-w-0">
                    <h3 className="truncate text-xs font-semibold">
                      {file.path}
                    </h3>
                    {file.index ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {file.index}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="text-emerald-600 dark:text-emerald-400">
                      +{file.additions}
                    </span>
                    <span className="text-rose-600 dark:text-rose-400">
                      -{file.deletions}
                    </span>
                  </div>
                </div>
                <div className="subtle-scrollbar overflow-x-auto bg-background select-text">
                  <div className="min-w-full py-1">
                    {file.hunks.map((hunk) => (
                      <React.Fragment
                        key={`${file.id}-${hunk.oldStart}-${hunk.newStart}`}
                      >
                        <DiffLine
                          line={`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                        />
                        {hunk.lines.map((line, index) => (
                          <DiffLine
                            key={`${file.id}-${hunk.oldStart}-${hunk.newStart}-${index}`}
                            language={language}
                            line={line}
                          />
                        ))}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <WarningCircleIcon />
          <span>No diff available for this session.</span>
        </div>
      )}
    </section>
  )
}

function DiffLine({
  line,
  language,
}: {
  line: string
  language?: CodeLanguage
}) {
  const baseClassName =
    "block whitespace-pre px-3 py-0.5 font-mono text-[11px] leading-relaxed sm:px-4"
  const marker = line[0] ?? ""
  const isAddition = line.startsWith("+") && !line.startsWith("+++")
  const isDeletion = line.startsWith("-") && !line.startsWith("---")
  const code =
    isAddition || isDeletion || line.startsWith(" ") ? line.slice(1) : line

  if (line.startsWith("@@")) {
    return (
      <span
        className={cn(
          baseClassName,
          "bg-sky-500/10 text-sky-700 dark:text-sky-300"
        )}
      >
        {line || " "}
      </span>
    )
  }

  return (
    <span
      className={cn(
        baseClassName,
        isAddition &&
          "border-l-2 border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        isDeletion &&
          "border-l-2 border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        !isAddition &&
          !isDeletion &&
          "border-l-2 border-transparent text-foreground/80"
      )}
    >
      {isAddition || isDeletion || line.startsWith(" ") ? (
        <>
          <span className="text-muted-foreground/70 select-none">{marker}</span>
          <CodeTokens code={code} language={language} />
        </>
      ) : (
        line || " "
      )}
    </span>
  )
}

type CodeLanguage =
  | "c"
  | "clike"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "toml"
  | "typescript"
  | "yaml"

type CodeToken = {
  text: string
  kind?:
    | "attr"
    | "comment"
    | "keyword"
    | "number"
    | "property"
    | "string"
    | "tag"
}

const TOKEN_CLASS_NAMES: Record<NonNullable<CodeToken["kind"]>, string> = {
  attr: "text-cyan-700 dark:text-cyan-300",
  comment: "text-muted-foreground",
  keyword: "font-semibold text-fuchsia-700 dark:text-fuchsia-300",
  number: "text-amber-700 dark:text-amber-300",
  property: "text-blue-700 dark:text-blue-300",
  string: "text-teal-700 dark:text-teal-300",
  tag: "font-semibold text-rose-700 dark:text-rose-300",
}

const KEYWORDS: Record<CodeLanguage, Set<string>> = {
  c: keywordSet(
    "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while"
  ),
  clike: keywordSet(
    "abstract as async await bool break case catch class const continue default do else enum extends false final finally for from function if implements import in interface is let new null private protected public readonly return static super switch this throw true try type undefined var void while"
  ),
  css: keywordSet("and from important media not only or supports to var"),
  go: keywordSet(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch type var"
  ),
  html: keywordSet(""),
  java: keywordSet(
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while"
  ),
  javascript: keywordSet(
    "as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield"
  ),
  json: keywordSet("false null true"),
  markdown: keywordSet(""),
  php: keywordSet(
    "abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield"
  ),
  python: keywordSet(
    "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield"
  ),
  ruby: keywordSet(
    "BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield"
  ),
  rust: keywordSet(
    "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"
  ),
  shell: keywordSet(
    "alias case cd do done elif else esac export fi for function if in local readonly return set shift then unset until while"
  ),
  sql: keywordSet(
    "alter and as asc by case create delete desc distinct drop else end exists false from group having in inner insert into is join left like limit not null on or order outer primary right select set table then true union update values when where"
  ),
  toml: keywordSet("false true"),
  typescript: keywordSet(
    "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let module namespace never new null number object of private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unknown var void while yield"
  ),
  yaml: keywordSet("false null true yes no on off"),
}

function CodeTokens({
  code,
  language,
}: {
  code: string
  language?: CodeLanguage
}) {
  const tokens = tokenizeCode(code, language)

  if (tokens.length === 0) {
    return <>{code || " "}</>
  }

  return (
    <>
      {tokens.map((token, index) =>
        token.kind ? (
          <span key={index} className={TOKEN_CLASS_NAMES[token.kind]}>
            {token.text}
          </span>
        ) : (
          <React.Fragment key={index}>{token.text}</React.Fragment>
        )
      )}
    </>
  )
}

function tokenizeCode(code: string, language?: CodeLanguage): CodeToken[] {
  if (!code || !language) {
    return code ? [{ text: code }] : []
  }

  if (language === "markdown") {
    return tokenizeMarkdown(code)
  }

  const tokens: CodeToken[] = []
  let rest = code

  while (rest.length > 0) {
    const token =
      matchComment(rest, language) ??
      matchString(rest) ??
      matchHtmlTag(rest, language) ??
      matchProperty(rest, language) ??
      matchNumber(rest) ??
      matchKeyword(rest, language) ??
      matchAttribute(rest, language) ??
      matchPlain(rest)

    tokens.push(token)
    rest = rest.slice(token.text.length)
  }

  return tokens
}

function matchComment(value: string, language: CodeLanguage): CodeToken | null {
  const comment =
    value.match(/^<!--.*?(?:-->|$)/)?.[0] ??
    value.match(/^\/\*.*?(?:\*\/|$)/)?.[0] ??
    (language === "python" || language === "ruby" || language === "shell"
      ? value.match(/^#.*/)?.[0]
      : null) ??
    (language === "sql" ? value.match(/^--.*/)?.[0] : null) ??
    value.match(/^\/\/.*/)?.[0]

  return comment ? { text: comment, kind: "comment" } : null
}

function matchString(value: string): CodeToken | null {
  const string =
    value.match(/^"(?:\\.|[^"\\])*"?/)?.[0] ??
    value.match(/^'(?:\\.|[^'\\])*'?/)?.[0] ??
    value.match(/^`(?:\\.|[^`\\])*`?/)?.[0]

  return string ? { text: string, kind: "string" } : null
}

function matchHtmlTag(value: string, language: CodeLanguage): CodeToken | null {
  if (
    language !== "html" &&
    language !== "javascript" &&
    language !== "typescript"
  ) {
    return null
  }

  const tag = value.match(/^<\/?[A-Za-z][\w:.-]*|^\/?>/)?.[0]
  return tag ? { text: tag, kind: "tag" } : null
}

function matchProperty(
  value: string,
  language: CodeLanguage
): CodeToken | null {
  const property =
    language === "json" || language === "yaml" || language === "toml"
      ? value.match(/^[A-Za-z_$][\w$.-]*(?=\s*[:=])/)?.[0]
      : language === "css"
        ? value.match(/^--?[\w-]+(?=\s*:)/)?.[0]
        : value.match(/^[A-Za-z_$][\w$]*(?=\s*:)/)?.[0]

  return property ? { text: property, kind: "property" } : null
}

function matchNumber(value: string): CodeToken | null {
  const number = value.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)(?:[a-z%]+)?/i)?.[0]
  return number ? { text: number, kind: "number" } : null
}

function matchKeyword(value: string, language: CodeLanguage): CodeToken | null {
  const word = value.match(/^[A-Za-z_$][\w$]*/)?.[0]
  if (!word || !KEYWORDS[language].has(word)) {
    return null
  }

  return { text: word, kind: "keyword" }
}

function matchAttribute(
  value: string,
  language: CodeLanguage
): CodeToken | null {
  if (
    language !== "html" &&
    language !== "javascript" &&
    language !== "typescript"
  ) {
    return null
  }

  const attribute = value.match(/^[A-Za-z_:][\w:.-]*(?=\s*=)/)?.[0]
  return attribute ? { text: attribute, kind: "attr" } : null
}

function matchPlain(value: string): CodeToken {
  return { text: value.match(/^\s+|^./s)?.[0] ?? value[0] ?? "" }
}

function tokenizeMarkdown(code: string): CodeToken[] {
  if (/^\s{0,3}#{1,6}\s/.test(code)) {
    return [{ text: code, kind: "keyword" }]
  }
  if (/^\s{0,3}(?:[-*+]|\d+\.)\s/.test(code)) {
    const [marker = "", content = ""] =
      code.match(/^(\s{0,3}(?:[-*+]|\d+\.)\s)(.*)$/)?.slice(1) ?? []
    return [{ text: marker, kind: "keyword" }, { text: content }]
  }

  const tokens: CodeToken[] = []
  let rest = code

  while (rest.length > 0) {
    const token = rest.match(/^`[^`]*`/)?.[0]
      ? { text: rest.match(/^`[^`]*`/)?.[0] ?? "", kind: "string" as const }
      : rest.match(/^\*\*[^*]+\*\*/)?.[0]
        ? {
            text: rest.match(/^\*\*[^*]+\*\*/)?.[0] ?? "",
            kind: "keyword" as const,
          }
        : matchPlain(rest)

    tokens.push(token)
    rest = rest.slice(token.text.length)
  }

  return tokens
}

function inferCodeLanguage(path: string): CodeLanguage | undefined {
  const normalized = path.toLowerCase()
  const fileName = normalized.split("/").pop() ?? normalized
  const compoundExtension = fileName.match(/(\.[^.]+){2,}$/)?.[0]
  const extension = fileName.match(/\.[^.]+$/)?.[0]

  if (
    fileName === "dockerfile" ||
    fileName === ".env" ||
    fileName.endsWith(".env") ||
    [".bashrc", ".zshrc"].includes(fileName)
  ) {
    return "shell"
  }

  if (
    [
      "go.mod",
      "go.sum",
      "pnpm-lock.yaml",
      "package-lock.json",
      "cargo.toml",
      "makefile",
    ].includes(fileName)
  ) {
    return inferSpecialFileLanguage(fileName)
  }

  switch (compoundExtension) {
    case ".d.ts":
      return "typescript"
    case ".test.ts":
    case ".spec.ts":
      return "typescript"
    case ".test.tsx":
    case ".spec.tsx":
      return "typescript"
    case ".test.js":
    case ".spec.js":
    case ".test.jsx":
    case ".spec.jsx":
      return "javascript"
    default:
      break
  }

  switch (extension) {
    case ".c":
    case ".h":
      return "c"
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".cs":
    case ".kt":
    case ".scala":
      return "clike"
    case ".css":
    case ".less":
    case ".scss":
      return "css"
    case ".go":
      return "go"
    case ".htm":
    case ".html":
    case ".svelte":
    case ".vue":
      return "html"
    case ".java":
      return "java"
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript"
    case ".json":
    case ".jsonc":
    case ".webmanifest":
      return "json"
    case ".md":
    case ".mdx":
      return "markdown"
    case ".php":
      return "php"
    case ".py":
    case ".pyi":
      return "python"
    case ".rb":
      return "ruby"
    case ".rs":
      return "rust"
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell"
    case ".sql":
      return "sql"
    case ".toml":
      return "toml"
    case ".ts":
    case ".tsx":
      return "typescript"
    case ".yaml":
    case ".yml":
      return "yaml"
    default:
      return undefined
  }
}

function inferSpecialFileLanguage(fileName: string): CodeLanguage {
  if (fileName.endsWith(".json")) {
    return "json"
  }
  if (fileName.endsWith(".yaml")) {
    return "yaml"
  }
  if (fileName.endsWith(".toml")) {
    return "toml"
  }
  if (fileName === "makefile") {
    return "shell"
  }
  return "go"
}

function keywordSet(value: string) {
  return new Set(value.split(/\s+/).filter(Boolean))
}

function parseDiffFiles(diff: string): DiffFile[] {
  if (!diff.trim()) {
    return []
  }

  try {
    return parsePatch(diff)
      .filter((patch) => patch.hunks.length > 0)
      .map((patch, index) => {
        const additions = patch.hunks.reduce(
          (total, hunk) =>
            total + hunk.lines.filter((line) => line.startsWith("+")).length,
          0
        )
        const deletions = patch.hunks.reduce(
          (total, hunk) =>
            total + hunk.lines.filter((line) => line.startsWith("-")).length,
          0
        )
        const path = formatDiffPath(patch)

        return {
          ...patch,
          id: `${index}-${path}`,
          path,
          additions,
          deletions,
        }
      })
  } catch (error) {
    console.error("Failed to parse git diff", error)
    return []
  }
}

function formatDiffPath(patch: StructuredPatch) {
  const fileName =
    patch.newFileName && patch.newFileName !== "/dev/null"
      ? patch.newFileName
      : patch.oldFileName
  return fileName.replace(/^[ab]\//, "")
}

function formatDiffType(type: SessionGitDiff["type"]) {
  if (type === "not_created") {
    return "Not created"
  }
  if (type === "uncommitted") {
    return "Uncommitted"
  }
  if (type === "commit") {
    return "Latest commit"
  }
  return "Empty"
}

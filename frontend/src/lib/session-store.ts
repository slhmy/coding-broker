import * as React from "react"

import { ApiError, api } from "@/lib/api"
import { parseDateTimeMillis } from "@/lib/datetime"
import type {
  CreateSessionInput,
  SendMessageInput,
  Session,
  SessionMode,
  SessionRecord,
  SessionSummary,
  UpdateSessionInput,
} from "@/types/domain"

type SessionStoreSnapshot = {
  summaries: SessionSummary[]
  details: Map<string, Session>
  isLoaded: boolean
}

type Listener = () => void

const POLL_INTERVAL_MS = 1500

let summaries: SessionSummary[] = []
let details = new Map<string, Session>()
let isLoaded = false
let snapshot: SessionStoreSnapshot = {
  summaries,
  details,
  isLoaded,
}

const listeners = new Set<Listener>()
const sessionRequests = new Map<string, Promise<Session>>()
let refreshSessionsRequest: Promise<SessionSummary[]> | null = null
let pollTimer: number | null = null

function toSummary(session: Session | SessionRecord): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    mode: session.mode,
    model: session.model,
    projectSlug: session.projectSlug,
    worktreeId: session.worktreeId,
    deletable: session.deletable,
    updatedAt: session.updatedAt,
  }
}

function sortSummaries(input: SessionSummary[]) {
  return [...input].sort((left, right) => {
    const currentBranchDifference = compareCurrentBranchFirst(left, right)
    if (currentBranchDifference !== 0) {
      return currentBranchDifference
    }

    const updatedAtDifference =
      (parseDateTimeMillis(right.updatedAt) ?? 0) -
      (parseDateTimeMillis(left.updatedAt) ?? 0)
    if (updatedAtDifference !== 0) {
      return updatedAtDifference
    }
    return compareDesc(left.id, right.id)
  })
}

function compareCurrentBranchFirst(
  left: SessionSummary,
  right: SessionSummary
) {
  const leftIsCurrentBranch = !left.worktreeId
  const rightIsCurrentBranch = !right.worktreeId

  if (leftIsCurrentBranch === rightIsCurrentBranch) {
    return 0
  }

  return leftIsCurrentBranch ? -1 : 1
}

function compareDesc(left: string, right: string) {
  if (right < left) {
    return -1
  }
  if (right > left) {
    return 1
  }
  return 0
}

function setDetails(nextDetails: Map<string, Session>) {
  details = nextDetails
}

function upsertSummary(record: SessionSummary | SessionRecord) {
  const summary = "createdAt" in record ? toSummary(record) : record
  const index = summaries.findIndex((candidate) => candidate.id === summary.id)
  const nextSummaries = [...summaries]

  if (index >= 0) {
    nextSummaries[index] = summary
  } else {
    nextSummaries.unshift(summary)
  }

  summaries = sortSummaries(nextSummaries)
}

function mergeSessionRecord(session: Session, record: SessionRecord): Session {
  const worktree =
    session.worktree && session.worktree.id === record.worktreeId
      ? session.worktree
      : undefined

  return {
    ...session,
    ...record,
    worktree,
  }
}

function upsertSessionRecord(record: SessionRecord) {
  const existing = details.get(record.id)
  if (existing) {
    return upsertSession(mergeSessionRecord(existing, record))
  }

  upsertSummary(record)
  emitChange()
  return record
}

function hasPendingPermission(session: Session) {
  return session.permissions.some(
    (permission) => permission.status === "pending"
  )
}

function isActiveSummary(summary: SessionSummary) {
  return summary.status === "running"
}

function isActiveSession(session: Session) {
  return isActiveSummary(session) || hasPendingPermission(session)
}

function getActiveSessionIds() {
  const activeIds = new Set<string>()

  for (const summary of summaries) {
    if (isActiveSummary(summary)) {
      activeIds.add(summary.id)
    }
  }

  for (const [sessionId, session] of details) {
    if (isActiveSession(session)) {
      activeIds.add(sessionId)
    }
  }

  return [...activeIds]
}

function removeMissingSession(sessionId: string, error: unknown) {
  if (error instanceof ApiError && error.status === 404) {
    removeSession(sessionId)
  }
}

function getSnapshot(): SessionStoreSnapshot {
  if (
    snapshot.summaries !== summaries ||
    snapshot.details !== details ||
    snapshot.isLoaded !== isLoaded
  ) {
    snapshot = {
      summaries,
      details,
      isLoaded,
    }
  }
  return snapshot
}

function ensurePolling() {
  const shouldPoll = listeners.size > 0 && getActiveSessionIds().length > 0

  if (!shouldPoll) {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
    return
  }

  if (pollTimer !== null) {
    return
  }

  pollTimer = window.setInterval(() => {
    void pollActiveSessions().catch(() => {
      // Let explicit UI actions surface request errors.
    })
  }, POLL_INTERVAL_MS)
}

function emitChange() {
  ensurePolling()
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  ensurePolling()

  return () => {
    listeners.delete(listener)
    ensurePolling()
  }
}

async function pollActiveSessions() {
  const activeSessionIds = getActiveSessionIds()
  if (activeSessionIds.length === 0) {
    return
  }

  await refreshSessions()
  await Promise.allSettled(
    activeSessionIds.map((sessionId) => refreshSession(sessionId))
  )
}

export function useSessionStore() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export async function refreshSessions() {
  if (refreshSessionsRequest) {
    return refreshSessionsRequest
  }

  refreshSessionsRequest = api
    .sessions()
    .then((records) => {
      summaries = sortSummaries(records.map(toSummary))
      isLoaded = true

      const validIds = new Set(records.map((session) => session.id))
      const recordById = new Map(
        records.map((session) => [session.id, session])
      )
      const nextDetails = new Map<string, Session>()
      for (const [sessionId, session] of details) {
        if (validIds.has(sessionId)) {
          const record = recordById.get(sessionId)
          nextDetails.set(
            sessionId,
            record ? mergeSessionRecord(session, record) : session
          )
        }
      }
      setDetails(nextDetails)
      emitChange()
      return summaries
    })
    .finally(() => {
      refreshSessionsRequest = null
    })

  return refreshSessionsRequest
}

export async function ensureSessionsLoaded() {
  if (isLoaded) {
    return summaries
  }

  return refreshSessions()
}

export async function refreshSession(sessionId: string) {
  const existingRequest = sessionRequests.get(sessionId)
  if (existingRequest) {
    return existingRequest
  }

  const request = api
    .session(sessionId)
    .then((session) => {
      upsertSession(session)
      return session
    })
    .catch((error) => {
      removeMissingSession(sessionId, error)
      throw error
    })
    .finally(() => {
      sessionRequests.delete(sessionId)
    })

  sessionRequests.set(sessionId, request)
  return request
}

export function upsertSession(session: Session) {
  const nextDetails = new Map(details)
  nextDetails.set(session.id, session)
  setDetails(nextDetails)
  upsertSummary(toSummary(session))
  isLoaded = true
  emitChange()
  return session
}

export function removeSession(sessionId: string) {
  summaries = summaries.filter((session) => session.id !== sessionId)
  const nextDetails = new Map(details)
  nextDetails.delete(sessionId)
  setDetails(nextDetails)
  emitChange()
}

export async function createSession(input: CreateSessionInput) {
  const session = await api.createSession(input)
  upsertSummary(session)
  isLoaded = true
  emitChange()
  return session
}

export async function deleteSession(sessionId: string) {
  try {
    await api.deleteSession(sessionId)
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      throw error
    }
  }
  removeSession(sessionId)
}

export async function updateMode(sessionId: string, mode: SessionMode) {
  try {
    return upsertSessionRecord(await api.updateMode(sessionId, mode))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function updateModel(sessionId: string, model: string) {
  try {
    return upsertSessionRecord(await api.updateModel(sessionId, model))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function markSessionRead(sessionId: string) {
  try {
    return upsertSessionRecord(await api.markSessionRead(sessionId))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput
) {
  try {
    return upsertSessionRecord(await api.updateSession(sessionId, input))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function sendMessage(sessionId: string, input: SendMessageInput) {
  try {
    return upsertSession(await api.sendMessage(sessionId, input))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function cancelSession(sessionId: string) {
  try {
    return upsertSession(await api.cancelSession(sessionId))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function clearSessionContext(sessionId: string) {
  try {
    return upsertSession(await api.clearSessionContext(sessionId))
  } catch (error) {
    removeMissingSession(sessionId, error)
    throw error
  }
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  decision: "allow" | "deny"
) {
  try {
    await api.respondPermission(sessionId, permissionId, decision)
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 409)
    ) {
      await Promise.allSettled([refreshSession(sessionId), refreshSessions()])
    }
    throw error
  }
  return refreshSession(sessionId)
}

package model

import (
	"encoding/json"
	"time"
)

type SessionMode string

const (
	SessionModeAsk  SessionMode = "ask"
	SessionModePlan SessionMode = "plan"
	SessionModeAct  SessionMode = "act"
)

type SessionStatus string

const (
	SessionStatusIdle    SessionStatus = "idle"
	SessionStatusRunning SessionStatus = "running"
	SessionStatusFailed  SessionStatus = "failed"
	SessionStatusDone    SessionStatus = "done"
)

type Project struct {
	Slug          string    `json:"slug"`
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	DefaultBranch string    `json:"defaultBranch"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type Session struct {
	ID          string        `json:"id"`
	ProjectSlug string        `json:"projectSlug"`
	Title       string        `json:"title"`
	Model       string        `json:"model"`
	Mode        SessionMode   `json:"mode"`
	Status      SessionStatus `json:"status"`
	WorktreeID  string        `json:"worktreeId,omitempty"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

type Message struct {
	ID        string      `json:"id"`
	SessionID string      `json:"sessionId"`
	Role      string      `json:"role"`
	Content   string      `json:"content"`
	Mode      SessionMode `json:"mode,omitempty"`
	CreatedAt time.Time   `json:"createdAt"`
}

type TimelineEvent struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId"`
	Kind      string          `json:"kind"`
	Title     string          `json:"title"`
	Summary   string          `json:"summary"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

type Worktree struct {
	ID                string    `json:"id"`
	SessionID         string    `json:"sessionId"`
	ProjectSlug       string    `json:"projectSlug"`
	Path              string    `json:"path"`
	Branch            string    `json:"branch"`
	CommitSHA         string    `json:"commitSha,omitempty"`
	Pushed            bool      `json:"pushed"`
	PullRequestURL    string    `json:"pullRequestUrl,omitempty"`
	PullRequestNumber int       `json:"pullRequestNumber,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type PermissionRequest struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	RequestID string    `json:"requestId"`
	ToolName  string    `json:"toolName"`
	ToolInput string    `json:"toolInput"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type SessionDetail struct {
	Session        Session             `json:"session"`
	Project        Project             `json:"project"`
	Messages       []Message           `json:"messages"`
	TimelineEvents []TimelineEvent     `json:"timelineEvents"`
	Worktree       *Worktree           `json:"worktree,omitempty"`
	Permissions    []PermissionRequest `json:"permissions"`
}

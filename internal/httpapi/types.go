package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/slhmy/coding-broker/internal/agent"
	"github.com/slhmy/coding-broker/internal/config"
	"github.com/slhmy/coding-broker/internal/model"
	"github.com/slhmy/coding-broker/internal/store"
)

type Dependencies struct {
	Config   config.Config
	Store    *store.Store
	Agent    AgentRunner
	Logger   *slog.Logger
	Frontend http.Handler
}

type AgentRunner interface {
	Respond(ctx context.Context, detail model.SessionDetail, userMessage string, onProgress func(agent.ProgressEvent)) (agent.RespondResult, error)
	RespondPermission(sessionID string, requestID string, allow bool) error
	CancelSession(sessionID string) bool
}

type API struct {
	cfg      config.Config
	store    *store.Store
	agent    AgentRunner
	logger   *slog.Logger
	frontend http.Handler
}

type projectDetailResponse struct {
	Slug          string             `json:"slug"`
	Name          string             `json:"name"`
	Path          string             `json:"path"`
	Description   string             `json:"description"`
	Branch        string             `json:"branch"`
	DefaultBranch string             `json:"defaultBranch"`
	Health        string             `json:"health"`
	CreatedAt     time.Time          `json:"createdAt"`
	UpdatedAt     time.Time          `json:"updatedAt"`
	WorktreeCount int                `json:"worktreeCount"`
	Git           gitStatusResponse  `json:"git"`
	Worktrees     []worktreeResponse `json:"worktrees"`
}

type gitStatusResponse struct {
	ProjectSlug   string     `json:"projectSlug"`
	Branch        string     `json:"branch"`
	DefaultBranch string     `json:"defaultBranch"`
	Ahead         int        `json:"ahead"`
	Behind        int        `json:"behind"`
	DirtyFiles    int        `json:"dirtyFiles"`
	Reachable     bool       `json:"reachable"`
	Message       *string    `json:"message"`
	LastPulledAt  *time.Time `json:"lastPulledAt"`
	PullMessage   *string    `json:"pullMessage"`
	LastPushedAt  *time.Time `json:"lastPushedAt"`
	PushMessage   *string    `json:"pushMessage"`
}

type worktreeResponse struct {
	ID                string            `json:"id"`
	SessionID         string            `json:"sessionId,omitempty"`
	ProjectSlug       string            `json:"projectSlug"`
	Name              string            `json:"name"`
	Branch            string            `json:"branch"`
	Path              string            `json:"path"`
	Status            string            `json:"status"`
	Git               gitStatusResponse `json:"git"`
	CommitSHA         string            `json:"commitSha,omitempty"`
	Pushed            bool              `json:"pushed"`
	PullRequestURL    string            `json:"pullRequestUrl,omitempty"`
	PullRequestNumber int               `json:"pullRequestNumber,omitempty"`
	LastUsedAt        time.Time         `json:"lastUsedAt"`
}

type sessionDetailResponse struct {
	Session        model.Session             `json:"session"`
	Project        model.Project             `json:"project"`
	Messages       []model.Message           `json:"messages"`
	TimelineEvents []model.TimelineEvent     `json:"timelineEvents"`
	Worktree       *worktreeResponse         `json:"worktree,omitempty"`
	Permissions    []model.PermissionRequest `json:"permissions"`
}

type sessionRecordResponse struct {
	model.Session
	Deletable bool `json:"deletable"`
}

type configResponse struct {
	DefaultModel    string   `json:"defaultModel"`
	AvailableModels []string `json:"availableModels"`
	WorkspaceRoot   string   `json:"workspaceRoot"`
	WorktreeRoot    string   `json:"worktreeRoot"`
}

type directoryBrowseResponse struct {
	HomePath    string                   `json:"homePath"`
	CurrentPath string                   `json:"currentPath"`
	ParentPath  *string                  `json:"parentPath"`
	Entries     []directoryEntryResponse `json:"entries"`
}

type directoryEntryResponse struct {
	Name            string `json:"name"`
	Path            string `json:"path"`
	Hidden          bool   `json:"hidden"`
	GitRepository   bool   `json:"gitRepository"`
	Unreadable      bool   `json:"unreadable"`
	PermissionError string `json:"permissionError,omitempty"`
}

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/slhmy/coding-broker/internal/agent"
	"github.com/slhmy/coding-broker/internal/id"
	"github.com/slhmy/coding-broker/internal/model"
	"github.com/slhmy/coding-broker/internal/pathutil"
	"github.com/slhmy/coding-broker/internal/store"
)

const (
	maxJSONBodyBytes        = 1 << 20
	timelinePayloadMaxRunes = 12000
)

func (api *API) browseDirectories(w http.ResponseWriter, r *http.Request) {
	rootPath, err := api.workspaceRoot()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	currentPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if currentPath == "" {
		currentPath = rootPath
	}
	currentPath, err = pathutil.ExpandUser(currentPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	currentPath, err = filepath.Abs(currentPath)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "path is invalid")
		return
	}
	currentPath, err = filepath.EvalSymlinks(currentPath)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "path must be an existing directory")
		return
	}
	if !pathWithinBase(rootPath, currentPath) {
		writeErrorMessage(w, http.StatusBadRequest, "path must be inside the workspace root")
		return
	}

	info, err := os.Stat(currentPath)
	if err != nil || !info.IsDir() {
		writeErrorMessage(w, http.StatusBadRequest, "path must be an existing directory")
		return
	}

	entries, err := directoryEntries(currentPath, r.URL.Query().Get("search"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	var parentPath *string
	if currentPath != rootPath {
		parent := filepath.Dir(currentPath)
		if pathWithinBase(rootPath, parent) {
			parentPath = &parent
		}
	}

	writeJSON(w, http.StatusOK, directoryBrowseResponse{
		HomePath:    rootPath,
		CurrentPath: currentPath,
		ParentPath:  parentPath,
		Entries:     entries,
	})
}

func (api *API) workspaceRoot() (string, error) {
	rootPath := strings.TrimSpace(api.cfg.WorkspaceRoot)
	if rootPath == "" || rootPath == "." {
		homePath, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(homePath) == "" {
			return "", fmt.Errorf("home directory is unavailable")
		}
		rootPath = homePath
	}
	rootPath, err := pathutil.ExpandUser(rootPath)
	if err != nil {
		return "", err
	}
	rootPath, err = filepath.Abs(rootPath)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(rootPath)
}

func (api *API) getConfig(w http.ResponseWriter, r *http.Request) {
	workspaceRoot, err := api.workspaceRoot()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	worktreeRoot, err := pathutil.ExpandUser(api.cfg.WorktreeRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if strings.TrimSpace(worktreeRoot) != "" {
		worktreeRoot, err = filepath.Abs(worktreeRoot)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, configResponse{
		DefaultModel:    api.defaultModel(),
		AvailableModels: api.availableModels(),
		WorkspaceRoot:   workspaceRoot,
		WorktreeRoot:    worktreeRoot,
	})
}

func (api *API) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := api.store.ListProjects(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	activeWorktrees, err := api.activeWorktreeIDs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	responses := make([]projectDetailResponse, 0, len(projects))
	for _, project := range projects {
		detail, err := api.projectDetail(r.Context(), project, activeWorktrees)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		responses = append(responses, detail)
	}
	writeJSON(w, http.StatusOK, responses)
}

func (api *API) createProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string `json:"name"`
		Path          string `json:"path"`
		DefaultBranch string `json:"defaultBranch"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		writeErrorMessage(w, http.StatusBadRequest, "path is required")
		return
	}
	projectPath, err := pathutil.ExpandUser(req.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	projectPath, err = filepath.Abs(projectPath)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "path is invalid")
		return
	}
	projectPath, err = filepath.EvalSymlinks(projectPath)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "path must be an existing directory")
		return
	}
	info, err := os.Stat(projectPath)
	if err != nil || !info.IsDir() {
		writeErrorMessage(w, http.StatusBadRequest, "path must be an existing directory")
		return
	}
	if _, err := commandOutput(projectPath, "git", "rev-parse", "--is-inside-work-tree"); err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "path must be a Git work tree")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = filepath.Base(projectPath)
	}
	defaultBranch := strings.TrimSpace(req.DefaultBranch)
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	if strings.ContainsAny(defaultBranch, " \t\r\n") {
		writeErrorMessage(w, http.StatusBadRequest, "defaultBranch must not contain whitespace")
		return
	}
	if _, err := commandOutput(projectPath, "git", "check-ref-format", "--branch", defaultBranch); err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "defaultBranch must be a valid branch name")
		return
	}
	slug := slugify(name)
	if slug == "" {
		writeErrorMessage(w, http.StatusBadRequest, "project name must contain letters or numbers")
		return
	}
	project := model.Project{
		Slug:          slug,
		Name:          name,
		Path:          projectPath,
		DefaultBranch: defaultBranch,
	}
	project, err = api.store.CreateProject(r.Context(), project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, project)
}

func (api *API) getProject(w http.ResponseWriter, r *http.Request) {
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	detail, err := api.projectDetail(r.Context(), project, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (api *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(chi.URLParam(r, "slug"))
	sessions, err := api.store.ListSessionsByProject(r.Context(), slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	for _, session := range sessions {
		if isActiveSessionStatus(session.Status) {
			writeErrorMessage(w, http.StatusConflict, "workspace has active sessions")
			return
		}
	}
	if err := api.store.DeleteProject(r.Context(), slug); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *API) pullProject(w http.ResponseWriter, r *http.Request) {
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "pull", api.cfg.GitRemote, project.DefaultBranch)
	cmd.Dir = project.Path
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git pull: %w\n%s", err, strings.TrimSpace(string(output))))
		return
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		message = "Already up to date."
	}
	status := api.gitStatus(project)
	now := time.Now().UTC()
	status.LastPulledAt = &now
	status.PullMessage = &message
	writeJSON(w, http.StatusOK, status)
}

func (api *API) pushProject(w http.ResponseWriter, r *http.Request) {
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "push", api.cfg.GitRemote, project.DefaultBranch)
	cmd.Dir = project.Path
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git push: %w\n%s", err, strings.TrimSpace(string(output))))
		return
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		message = "Everything up-to-date."
	}
	status := api.gitStatus(project)
	now := time.Now().UTC()
	status.LastPushedAt = &now
	status.PushMessage = &message
	writeJSON(w, http.StatusOK, status)
}

func (api *API) pullProjectWorktree(w http.ResponseWriter, r *http.Request) {
	project, worktree, ok := api.projectWorktreeForRequest(w, r)
	if !ok {
		return
	}
	status, err := api.runGitSync(r.Context(), project, worktree.Path, "pull", worktree.Branch)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (api *API) pushProjectWorktree(w http.ResponseWriter, r *http.Request) {
	project, worktree, ok := api.projectWorktreeForRequest(w, r)
	if !ok {
		return
	}
	status, err := api.runGitSync(r.Context(), project, worktree.Path, "push", worktree.Branch)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if head, headErr := commandOutput(worktree.Path, "git", "rev-parse", "HEAD"); headErr == nil {
		_ = api.store.UpdateWorktreeResult(r.Context(), worktree.ID, strings.TrimSpace(head), true)
	}
	writeJSON(w, http.StatusOK, status)
}

func (api *API) integrateProjectWorktree(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Strategy        string `json:"strategy"`
		TargetSessionID string `json:"targetSessionId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	strategy := strings.ToLower(strings.TrimSpace(req.Strategy))
	if strategy != "merge" && strategy != "rebase" {
		writeErrorMessage(w, http.StatusBadRequest, "strategy must be merge or rebase")
		return
	}
	project, worktree, ok := api.projectWorktreeForRequest(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(worktree.CommitSHA) == "" {
		if head, err := commandOutput(worktree.Path, "git", "rev-parse", "HEAD"); err == nil {
			worktree.CommitSHA = strings.TrimSpace(head)
			_ = api.store.UpdateWorktreeResult(r.Context(), worktree.ID, worktree.CommitSHA, worktree.Pushed)
		}
	}
	targetSessionID := strings.TrimSpace(req.TargetSessionID)
	var session model.Session
	var err error
	if targetSessionID != "" {
		detail, err := api.store.GetSessionDetail(r.Context(), targetSessionID)
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		if detail.Session.ProjectSlug != project.Slug {
			writeErrorMessage(w, http.StatusBadRequest, "target session must belong to the same project")
			return
		}
		session = detail.Session
	} else {
		session, err = api.ensureSessionForTarget(r.Context(), project, "", "Current branch", api.defaultModel(), "")
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}
	detail, err := api.store.GetSessionDetail(r.Context(), session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if isActiveSessionStatus(detail.Session.Status) {
		writeErrorMessage(w, http.StatusConflict, "workspace session already has an active run")
		return
	}
	if api.agent == nil {
		writeErrorMessage(w, http.StatusServiceUnavailable, "agent runner is unavailable")
		return
	}
	if detail.Session.Mode != model.SessionModeAct {
		session, err = api.store.UpdateSessionMode(r.Context(), session.ID, model.SessionModeAct)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		detail.Session = session
	}
	prompt := integrationPrompt(strategy, project, worktree)
	message, err := api.store.AddMessage(r.Context(), model.Message{
		ID:        id.New("msg"),
		SessionID: session.ID,
		Role:      "user",
		Content:   prompt,
		Mode:      detail.Session.Mode,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := api.store.UpdateSessionStatus(r.Context(), session.ID, model.SessionStatusRunning, detail.Session.WorktreeID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	detail.Messages = append(detail.Messages, message)
	go api.respondToQueuedMessages(detail)
	writeJSON(w, http.StatusAccepted, map[string]any{"session": session, "messages": []model.Message{message}})
}

func (api *API) projectWorktreeForRequest(w http.ResponseWriter, r *http.Request) (model.Project, model.Worktree, bool) {
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return model.Project{}, model.Worktree{}, false
	}
	worktree, err := api.store.GetWorktree(r.Context(), chi.URLParam(r, "worktreeID"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return model.Project{}, model.Worktree{}, false
	}
	if worktree.ProjectSlug != project.Slug {
		writeErrorMessage(w, http.StatusNotFound, "worktree not found")
		return model.Project{}, model.Worktree{}, false
	}
	if err := api.ensureWorktreeOnDisk(r.Context(), project, worktree); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return model.Project{}, model.Worktree{}, false
	}
	return project, worktree, true
}

func (api *API) runGitSync(ctx context.Context, project model.Project, dir string, action string, branch string) (gitStatusResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", action, api.cfg.GitRemote, branch)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return gitStatusResponse{}, fmt.Errorf("git %s: %w\n%s", action, err, strings.TrimSpace(string(output)))
	}
	message := strings.TrimSpace(string(output))
	if message == "" {
		if action == "push" {
			message = "Everything up-to-date."
		} else {
			message = "Already up to date."
		}
	}
	status := api.gitStatusForPath(project, dir)
	now := time.Now().UTC()
	if action == "push" {
		status.LastPushedAt = &now
		status.PushMessage = &message
	} else {
		status.LastPulledAt = &now
		status.PullMessage = &message
	}
	return status, nil
}

func (api *API) listProjectWorktrees(w http.ResponseWriter, r *http.Request) {
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	worktrees, err := api.store.ListWorktreesByProject(r.Context(), project.Slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	activeWorktrees, err := api.activeWorktreeIDs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.mapWorktrees(project, worktrees, activeWorktrees))
}

func (api *API) createProjectWorktree(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Branch string `json:"branch"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	project, err := api.getCanonicalProject(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	branch := strings.TrimSpace(req.Branch)
	if name == "" || branch == "" {
		writeErrorMessage(w, http.StatusBadRequest, "name and branch are required")
		return
	}
	if !validWorktreeName(name) {
		writeErrorMessage(w, http.StatusBadRequest, "worktree name must be a single directory name")
		return
	}
	if strings.ContainsAny(branch, " \t\r\n") {
		writeErrorMessage(w, http.StatusBadRequest, "branch must not contain whitespace")
		return
	}
	if _, err := commandOutput(project.Path, "git", "check-ref-format", "--branch", branch); err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "branch must be a valid branch name")
		return
	}
	worktreeRoot, err := pathutil.ExpandUser(api.cfg.WorktreeRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if strings.TrimSpace(worktreeRoot) == "" {
		writeErrorMessage(w, http.StatusBadRequest, "worktree root is required")
		return
	}
	worktreeRoot, err = filepath.Abs(worktreeRoot)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "worktree root is invalid")
		return
	}
	worktree := model.Worktree{
		ID:          id.New("wt"),
		ProjectSlug: project.Slug,
		Path:        filepath.Join(worktreeRoot, name),
		Branch:      branch,
	}
	if err := os.MkdirAll(worktreeRoot, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "worktree", "add", "-B", branch, worktree.Path, project.DefaultBranch)
	cmd.Dir = project.Path
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git worktree add: %w\n%s", err, strings.TrimSpace(string(output))))
		return
	}
	worktree, err = api.store.SaveWorktree(r.Context(), worktree)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	session, err := api.ensureSessionForTarget(r.Context(), project, worktree.ID, "", "", "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	worktree.SessionID = session.ID
	if err := api.store.UpdateWorktreeSessionID(r.Context(), worktree.ID, session.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, api.mapWorktree(project, worktree, nil))
}

func (api *API) switchProjectWorktree(w http.ResponseWriter, r *http.Request) {
	worktree, err := api.store.GetWorktree(r.Context(), chi.URLParam(r, "worktreeID"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if worktree.ProjectSlug != chi.URLParam(r, "slug") {
		writeErrorMessage(w, http.StatusNotFound, "worktree not found")
		return
	}
	activeWorktrees, err := api.activeWorktreeIDs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	project, err := api.getCanonicalProject(r.Context(), worktree.ProjectSlug)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, api.mapWorktree(project, worktree, activeWorktrees))
}

func (api *API) deleteProjectWorktree(w http.ResponseWriter, r *http.Request) {
	worktree, err := api.store.GetWorktree(r.Context(), chi.URLParam(r, "worktreeID"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if worktree.ProjectSlug != chi.URLParam(r, "slug") {
		writeErrorMessage(w, http.StatusNotFound, "worktree not found")
		return
	}
	if strings.TrimSpace(worktree.SessionID) != "" {
		session, err := api.store.GetSession(r.Context(), worktree.SessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if err == nil && isActiveSessionStatus(session.Status) {
			writeErrorMessage(w, http.StatusConflict, "active worktree cannot be removed")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	project, err := api.getCanonicalProject(r.Context(), worktree.ProjectSlug)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	cmd := exec.CommandContext(ctx, "git", "worktree", "remove", "--force", worktree.Path)
	cmd.Dir = project.Path
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git worktree remove: %w\n%s", err, strings.TrimSpace(string(output))))
		return
	}
	if err := api.store.DeleteWorktree(r.Context(), worktree.ID); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if api.agent != nil && strings.TrimSpace(worktree.SessionID) != "" {
		api.agent.CancelSession(worktree.SessionID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *API) listSessions(w http.ResponseWriter, r *http.Request) {
	projectSlug := strings.TrimSpace(r.URL.Query().Get("project"))
	if projectSlug == "" {
		projectSlug = strings.TrimSpace(r.URL.Query().Get("workspace"))
	}
	var (
		sessions []model.Session
		err      error
	)
	if projectSlug != "" {
		sessions, err = api.store.ListSessionsByProject(r.Context(), projectSlug)
	} else {
		sessions, err = api.store.ListSessions(r.Context())
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, mapSessions(sessions))
}

func (api *API) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectSlug      string `json:"projectSlug"`
		Prompt           string `json:"prompt"`
		Model            string `json:"model"`
		WorktreeID       string `json:"worktreeId"`
		UseCurrentBranch bool   `json:"useCurrentBranch"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	projectSlug := strings.TrimSpace(req.ProjectSlug)
	project, err := api.store.GetProject(r.Context(), projectSlug)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) || projectSlug == "" {
			status = http.StatusBadRequest
		}
		writeErrorMessage(w, status, "projectSlug is required")
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	title := prompt
	if prompt == "" {
		if req.UseCurrentBranch {
			title = "Current branch"
		} else {
			title = "Work on " + project.Name
		}
	}
	title = truncateRunes(title, 80)
	sessionModel, ok := api.normalizeModel(req.Model)
	if !ok {
		writeErrorMessage(w, http.StatusBadRequest, "invalid model")
		return
	}

	worktreeRoot, err := pathutil.ExpandUser(api.cfg.WorktreeRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if strings.TrimSpace(worktreeRoot) == "" {
		worktreeRoot = "./data/worktrees"
	}
	worktreeRoot, err = filepath.Abs(worktreeRoot)
	if err != nil {
		writeErrorMessage(w, http.StatusBadRequest, "worktree root is invalid")
		return
	}

	var targetWorktreeID string
	if req.UseCurrentBranch {
		targetWorktreeID = ""
	} else if req.WorktreeID != "" {
		wt, err := api.store.GetWorktree(r.Context(), req.WorktreeID)
		if err != nil || wt.ProjectSlug != project.Slug {
			writeErrorMessage(w, http.StatusBadRequest, "specified worktree not found")
			return
		}
		targetWorktreeID = wt.ID
	} else {
		sessionID := id.New("ses")
		wtID := id.New("wt")
		wtName := sessionID
		wtBranch := fmt.Sprintf("agent/%s", sessionID)
		wtPath := filepath.Join(worktreeRoot, wtName)

		wt := model.Worktree{
			ID:          wtID,
			SessionID:   sessionID,
			ProjectSlug: project.Slug,
			Path:        wtPath,
			Branch:      wtBranch,
		}

		if err := api.ensureWorktreeOnDisk(r.Context(), project, wt); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		wt, err = api.store.SaveWorktree(r.Context(), wt)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		targetWorktreeID = wt.ID
	}

	session, err := api.ensureSessionForTarget(r.Context(), project, targetWorktreeID, title, sessionModel, prompt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if targetWorktreeID != "" {
		if wt, getErr := api.store.GetWorktree(r.Context(), targetWorktreeID); getErr == nil && strings.TrimSpace(wt.SessionID) != session.ID {
			if err := api.store.UpdateWorktreeSessionID(r.Context(), wt.ID, session.ID); err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
		}
	}
	writeJSON(w, http.StatusCreated, mapSession(session))
}

func (api *API) getSession(w http.ResponseWriter, r *http.Request) {
	detail, err := api.store.GetSessionDetail(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, api.mapSessionDetail(detail))
}

func (api *API) deleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if !sessionDeletable(session) {
		writeErrorMessage(w, http.StatusConflict, "current branch session cannot be deleted")
		return
	}
	if isActiveSessionStatus(session.Status) {
		writeErrorMessage(w, http.StatusConflict, "active session cannot be deleted")
		return
	}
	if strings.TrimSpace(session.WorktreeID) != "" {
		api.deleteSessionWorktree(w, r, session)
		return
	}
	if err := api.store.DeleteSession(r.Context(), sessionID); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if api.agent != nil {
		api.agent.CancelSession(sessionID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *API) deleteSessionWorktree(w http.ResponseWriter, r *http.Request, session model.Session) {
	worktree, err := api.store.GetWorktree(r.Context(), session.WorktreeID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if worktree.ProjectSlug != session.ProjectSlug {
		writeErrorMessage(w, http.StatusConflict, "session worktree does not belong to the session project")
		return
	}
	project, err := api.getCanonicalProject(r.Context(), worktree.ProjectSlug)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}

	if strings.TrimSpace(worktree.Path) != "" {
		if _, err := os.Stat(worktree.Path); err != nil {
			if !os.IsNotExist(err) {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
		} else {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, "git", "worktree", "remove", "--force", worktree.Path)
			cmd.Dir = project.Path
			output, err := cmd.CombinedOutput()
			if err != nil {
				writeError(w, http.StatusInternalServerError, fmt.Errorf("git worktree remove: %w\n%s", err, strings.TrimSpace(string(output))))
				return
			}
		}
	}
	if err := api.store.DeleteWorktree(r.Context(), worktree.ID); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if api.agent != nil {
		api.agent.CancelSession(session.ID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (api *API) clearSessionContext(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if isActiveSessionStatus(session.Status) {
		writeErrorMessage(w, http.StatusConflict, "cannot clear context while session is running")
		return
	}
	if api.agent != nil {
		api.agent.CancelSession(sessionID)
	}
	if err := api.store.ClearSessionContext(r.Context(), sessionID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	detail, err := api.store.GetSessionDetail(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.mapSessionDetail(detail))
}

func (api *API) updateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title      *string            `json:"title"`
		Mode       *model.SessionMode `json:"mode"`
		Model      *string            `json:"model"`
		WorktreeID *string            `json:"worktreeId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	session, err := api.store.GetSession(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	updated := session
	if req.Title != nil {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			writeErrorMessage(w, http.StatusBadRequest, "title is required")
			return
		}
		updated.Title = truncateRunes(title, 80)
	}
	if req.Mode != nil {
		if !validSessionMode(*req.Mode) {
			writeErrorMessage(w, http.StatusBadRequest, "invalid mode")
			return
		}
		updated.Mode = *req.Mode
	}
	if req.Model != nil {
		sessionModel, ok := api.normalizeModel(*req.Model)
		if !ok {
			writeErrorMessage(w, http.StatusBadRequest, "invalid model")
			return
		}
		updated.Model = sessionModel
	}
	if req.WorktreeID != nil {
		worktreeID := strings.TrimSpace(*req.WorktreeID)
		if worktreeID != "" {
			wt, err := api.store.GetWorktree(r.Context(), worktreeID)
			if err != nil || wt.ProjectSlug != session.ProjectSlug {
				writeErrorMessage(w, http.StatusBadRequest, "specified worktree not found")
				return
			}
		}
		updated.WorktreeID = worktreeID
	}
	if updated.Title == session.Title && updated.Mode == session.Mode && updated.Model == session.Model && updated.WorktreeID == session.WorktreeID {
		writeJSON(w, http.StatusOK, mapSession(session))
		return
	}
	session, err = api.store.UpdateSession(r.Context(), updated)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, mapSession(session))
}

func (api *API) updateMode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode model.SessionMode `json:"mode"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validSessionMode(req.Mode) {
		writeErrorMessage(w, http.StatusBadRequest, "invalid mode")
		return
	}
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if session.Mode == req.Mode {
		writeJSON(w, http.StatusOK, mapSession(session))
		return
	}
	session, err = api.store.UpdateSessionMode(r.Context(), sessionID, req.Mode)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, mapSession(session))
}

func validSessionMode(mode model.SessionMode) bool {
	return mode == model.SessionModeAsk || mode == model.SessionModePlan || mode == model.SessionModeAct
}

func isActiveSessionStatus(status model.SessionStatus) bool {
	return status == model.SessionStatusRunning
}

func (api *API) updateModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	sessionModel, ok := api.normalizeModel(req.Model)
	if !ok {
		writeErrorMessage(w, http.StatusBadRequest, "invalid model")
		return
	}
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if session.Model == sessionModel {
		writeJSON(w, http.StatusOK, mapSession(session))
		return
	}
	session, err = api.store.UpdateSessionModel(r.Context(), sessionID, sessionModel)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, mapSession(session))
}

func (api *API) markSessionRead(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.MarkSessionRead(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, mapSession(session))
}

func (api *API) cancelSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}

	closed := false
	if api.agent != nil {
		closed = api.agent.CancelSession(sessionID)
	}
	if err := api.store.UpdateSessionStatus(r.Context(), sessionID, model.SessionStatusIdle, session.WorktreeID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	api.addTimelineEvent(r.Context(), model.TimelineEvent{
		ID:        id.New("evt"),
		SessionID: sessionID,
		Kind:      "run_status",
		Title:     "Agent canceled",
		Summary:   "The active run was stopped by the user.",
		Payload:   mustJSON(map[string]any{"reason": "user canceled"}),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "closed": closed})
}

func (api *API) addMessage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		writeErrorMessage(w, http.StatusBadRequest, "content is required")
		return
	}
	sessionID := chi.URLParam(r, "id")
	detail, err := api.store.GetSessionDetail(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	wasActive := isActiveSessionStatus(detail.Session.Status)
	if api.agent == nil && !wasActive {
		writeErrorMessage(w, http.StatusServiceUnavailable, "agent runner is unavailable")
		return
	}
	if !wasActive && detail.Worktree != nil {
		detail.Project = canonicalProjectPath(detail.Project)
		if err := api.ensureWorktreeOnDisk(r.Context(), detail.Project, *detail.Worktree); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}
	message, err := api.store.AddMessage(r.Context(), model.Message{
		ID:        id.New("msg"),
		SessionID: sessionID,
		Role:      "user",
		Content:   content,
		Mode:      detail.Session.Mode,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if wasActive {
		api.addTimelineEvent(r.Context(), model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "run_status",
			Title:     "Prompt queued",
			Summary:   fmt.Sprintf("%d pending prompt(s) will run after the current response.", pendingQueuedUserMessageCount(append(detail.Messages, message))),
			Payload:   mustJSON(map[string]any{"pendingPrompts": pendingQueuedUserMessageCount(append(detail.Messages, message))}),
		})
		writeJSON(w, http.StatusAccepted, []model.Message{message})
		return
	}
	if err := api.store.UpdateSessionStatus(r.Context(), sessionID, model.SessionStatusRunning, detail.Session.WorktreeID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	api.addAgentStartedEvent(r.Context(), detail.Session)
	detail.Messages = append(detail.Messages, message)
	go api.respondToQueuedMessages(detail)
	writeJSON(w, http.StatusAccepted, []model.Message{message})
}

func (api *API) respondToQueuedMessages(detail model.SessionDetail) {
	ctx := context.Background()
	detail.Project = canonicalProjectPath(detail.Project)

	for {
		content, history, ok := nextQueuedUserMessage(detail.Messages)
		if !ok {
			if err := api.store.UpdateSessionStatus(ctx, detail.Session.ID, model.SessionStatusDone, detail.Session.WorktreeID); err != nil {
				api.logger.Error("failed to mark session done", "session", detail.Session.ID, "error", err)
			}
			return
		}
		runDetail := detail
		runDetail.Messages = history
		result, err := api.agent.Respond(ctx, runDetail, content, func(event agent.ProgressEvent) {
			if event.Kind == "permission" && event.RequestID != "" {
				permission, saveErr := api.store.SavePermission(ctx, model.PermissionRequest{
					ID:        id.New("perm"),
					SessionID: detail.Session.ID,
					RequestID: event.RequestID,
					ToolName:  event.ToolName,
					ToolInput: event.ToolInput,
					Status:    "pending",
				})
				if saveErr != nil {
					api.logger.Error("failed to save permission request", "session", detail.Session.ID, "error", saveErr)
				} else {
					api.addTimelineEvent(ctx, timelineEventFromProgress(detail.Session.ID, event, permission.ID))
				}
			}
			api.addTimelineEvent(ctx, timelineEventFromProgress(detail.Session.ID, event, ""))
		})
		if err != nil {
			api.logger.Error("agent response failed", "session", detail.Session.ID, "error", err)
			if statusErr := api.store.UpdateSessionStatus(ctx, detail.Session.ID, model.SessionStatusFailed, detail.Session.WorktreeID); statusErr != nil {
				api.logger.Error("failed to mark session failed", "session", detail.Session.ID, "error", statusErr)
			}
			_, saveErr := api.store.AddMessage(ctx, model.Message{
				ID:        id.New("msg"),
				SessionID: detail.Session.ID,
				Role:      "assistant",
				Content:   fmt.Sprintf("Agent run failed: %s", agentErrorMessage(err)),
				Mode:      runDetail.Session.Mode,
			})
			if saveErr != nil {
				api.logger.Error("failed to save agent error message", "session", detail.Session.ID, "error", saveErr)
			}
			api.addTimelineEvent(ctx, model.TimelineEvent{
				ID:        id.New("evt"),
				SessionID: detail.Session.ID,
				Kind:      "error",
				Title:     "Agent run failed",
				Summary:   agentErrorMessage(err),
				Payload:   mustJSON(map[string]any{"error": agentErrorMessage(err)}),
			})
			return
		}
		if _, err := api.store.AddMessage(ctx, model.Message{
			ID:        id.New("msg"),
			SessionID: detail.Session.ID,
			Role:      "assistant",
			Content:   result.Content,
			Mode:      runDetail.Session.Mode,
		}); err != nil {
			api.logger.Error("failed to save agent reply", "session", detail.Session.ID, "error", err)
			return
		}
		latest, err := api.store.GetSessionDetail(ctx, detail.Session.ID)
		if err != nil {
			api.logger.Error("failed to reload session queue", "session", detail.Session.ID, "error", err)
			return
		}
		latest.Project = detail.Project
		detail = latest
	}
}

func (api *API) addAgentStartedEvent(ctx context.Context, session model.Session) {
	api.addTimelineEvent(ctx, model.TimelineEvent{
		ID:        id.New("evt"),
		SessionID: session.ID,
		Kind:      "run_status",
		Title:     "Agent started",
		Summary:   fmt.Sprintf("Started in %s mode.", session.Mode),
		Payload:   mustJSON(map[string]any{"mode": session.Mode}),
	})
}

func nextQueuedUserMessage(messages []model.Message) (string, []model.Message, bool) {
	completedUserMessages := 0
	for _, message := range messages {
		if message.Role == "assistant" {
			completedUserMessages++
		}
	}
	seenUserMessages := 0
	for _, message := range messages {
		if message.Role != "user" {
			continue
		}
		seenUserMessages++
		if seenUserMessages > completedUserMessages {
			return message.Content, completedConversationHistory(messages, completedUserMessages), true
		}
	}
	return "", messages, false
}

func completedConversationHistory(messages []model.Message, completedUserMessages int) []model.Message {
	history := make([]model.Message, 0, len(messages))
	seenUserMessages := 0
	for _, message := range messages {
		if message.Role == "user" {
			seenUserMessages++
			if seenUserMessages > completedUserMessages {
				continue
			}
		}
		history = append(history, message)
	}
	return history
}

func hasQueuedUserMessage(messages []model.Message) bool {
	_, _, ok := nextQueuedUserMessage(messages)
	return ok
}

func pendingQueuedUserMessageCount(messages []model.Message) int {
	completedUserMessages := 0
	userMessages := 0
	for _, message := range messages {
		if message.Role == "user" {
			userMessages++
		}
		if message.Role == "assistant" {
			completedUserMessages++
		}
	}
	if userMessages <= completedUserMessages {
		return 0
	}
	pendingMessages := userMessages - completedUserMessages - 1
	if pendingMessages < 0 {
		return 0
	}
	return pendingMessages
}

func agentErrorMessage(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "the request was canceled or exceeded its deadline."
	}
	if errors.Is(err, agent.ErrIdleTimeout) {
		return "the run stopped after a long period with no agent output. You can retry, or increase agent.idle_timeout if this task is expected to stay quiet for longer."
	}
	return err.Error()
}

func (api *API) addTimelineEvent(ctx context.Context, event model.TimelineEvent) {
	event.Title = strings.TrimSpace(event.Title)
	event.Summary = strings.TrimSpace(event.Summary)
	if event.Title == "" {
		return
	}
	if event.ID == "" {
		event.ID = id.New("evt")
	}
	if event.Payload == nil {
		event.Payload = []byte("{}")
	}
	if _, err := api.store.AddTimelineEvent(ctx, event); err != nil {
		api.logger.Error("failed to save agent progress", "session", event.SessionID, "error", err)
	}
}

func timelineEventFromProgress(sessionID string, event agent.ProgressEvent, permissionID string) model.TimelineEvent {
	switch event.Kind {
	case "thinking":
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "thinking",
			Title:     "Thinking",
			Summary:   compactSummary(event.Content),
			Payload:   mustJSON(map[string]any{"content": event.Content}),
		}
	case "tool_use":
		if isPatchTool(event.ToolName, event.ToolInput) {
			return fileChangeTimelineEvent(sessionID, event)
		}
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "tool_call",
			Title:     "Tool started",
			Summary:   toolEventSummary(event.ToolName, event.ToolInput),
			Payload: mustJSON(map[string]any{
				"toolName":  event.ToolName,
				"toolInput": event.ToolInput,
				"content":   event.Content,
			}),
		}
	case "tool_result":
		if looksLikeDiff(event.ToolResult) {
			return fileChangeTimelineEvent(sessionID, agent.ProgressEvent{
				Kind:      event.Kind,
				Content:   event.Content,
				ToolName:  event.ToolName,
				ToolInput: event.ToolResult,
			})
		}
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "tool_result",
			Title:     "Tool finished",
			Summary:   toolResultSummary(event),
			Payload: mustJSON(map[string]any{
				"toolName":    event.ToolName,
				"toolInput":   event.ToolInput,
				"toolResult":  event.ToolResult,
				"toolStatus":  event.ToolStatus,
				"toolSuccess": event.ToolSuccess,
				"content":     event.Content,
			}),
		}
	case "permission":
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "permission_request",
			Title:     "Permission requested",
			Summary:   toolEventSummary(event.ToolName, event.ToolInput),
			Payload: mustJSON(map[string]any{
				"permissionId": permissionID,
				"requestId":    event.RequestID,
				"toolName":     event.ToolName,
				"toolInput":    event.ToolInput,
				"content":      event.Content,
			}),
		}
	case "error":
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "error",
			Title:     "Agent error",
			Summary:   compactSummary(event.Content),
			Payload:   mustJSON(map[string]any{"content": event.Content}),
		}
	default:
		return model.TimelineEvent{
			ID:        id.New("evt"),
			SessionID: sessionID,
			Kind:      "run_status",
			Title:     "Agent event",
			Summary:   compactSummary(event.Content),
			Payload:   mustJSON(map[string]any{"content": event.Content, "kind": event.Kind}),
		}
	}
}

func fileChangeTimelineEvent(sessionID string, event agent.ProgressEvent) model.TimelineEvent {
	files, additions, deletions := summarizePatchInput(event.ToolInput)
	patch, truncated := truncateTimelinePayload(event.ToolInput)
	summary := "Code edited"
	if len(files) == 1 {
		summary = fmt.Sprintf("Changed %s", files[0]["path"])
	} else if len(files) > 1 {
		summary = fmt.Sprintf("Changed %d files", len(files))
	}
	return model.TimelineEvent{
		ID:        id.New("evt"),
		SessionID: sessionID,
		Kind:      "file_change",
		Title:     "Code edited",
		Summary:   summary,
		Payload: mustJSON(map[string]any{
			"files":     files,
			"additions": additions,
			"deletions": deletions,
			"patch":     patch,
			"truncated": truncated,
			"toolName":  event.ToolName,
		}),
	}
}

func isPatchTool(toolName string, input string) bool {
	name := strings.ToLower(strings.TrimSpace(toolName))
	body := strings.TrimSpace(input)
	return name == "patch" || strings.HasPrefix(body, "*** Begin Patch") || strings.HasPrefix(body, "[") && strings.Contains(body, `"path"`)
}

func looksLikeDiff(value string) bool {
	body := strings.TrimSpace(value)
	return strings.Contains(body, "\ndiff --git ") ||
		strings.HasPrefix(body, "diff --git ") ||
		strings.HasPrefix(body, "*** Begin Patch")
}

func summarizePatchInput(input string) ([]map[string]any, int, int) {
	body := strings.TrimSpace(input)
	files := make([]map[string]any, 0)
	if strings.HasPrefix(body, "[") {
		var raw []map[string]any
		if err := json.Unmarshal([]byte(body), &raw); err == nil {
			for _, item := range raw {
				path := stringFromAny(item["path"])
				if path == "" {
					path = stringFromAny(item["file"])
				}
				if path == "" {
					continue
				}
				operation := stringFromAny(item["type"])
				if operation == "" {
					operation = stringFromAny(item["operation"])
				}
				if operation == "" {
					operation = "modified"
				}
				files = append(files, map[string]any{"path": path, "operation": operation, "additions": 0, "deletions": 0})
			}
			return files, 0, 0
		}
	}
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			if len(files) > 0 {
				files[len(files)-1]["additions"] = intFromAny(files[len(files)-1]["additions"]) + 1
			}
			continue
		}
		if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
			if len(files) > 0 {
				files[len(files)-1]["deletions"] = intFromAny(files[len(files)-1]["deletions"]) + 1
			}
			continue
		}
		if path, ok := diffGitFileLine(line); ok {
			files = append(files, map[string]any{"path": path, "operation": "modified", "additions": 0, "deletions": 0})
			continue
		}
		matchPath, operation := patchFileLine(line)
		if matchPath == "" {
			continue
		}
		files = append(files, map[string]any{"path": matchPath, "operation": operation, "additions": 0, "deletions": 0})
	}
	additions := 0
	deletions := 0
	for _, file := range files {
		additions += intFromAny(file["additions"])
		deletions += intFromAny(file["deletions"])
	}
	return files, additions, deletions
}

func patchFileLine(line string) (string, string) {
	for _, prefix := range []struct {
		text      string
		operation string
	}{
		{"*** Add File: ", "added"},
		{"*** Update File: ", "modified"},
		{"*** Delete File: ", "deleted"},
	} {
		if strings.HasPrefix(line, prefix.text) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix.text)), prefix.operation
		}
	}
	return "", ""
}

func diffGitFileLine(line string) (string, bool) {
	if !strings.HasPrefix(line, "diff --git ") {
		return "", false
	}
	parts := strings.Fields(line)
	if len(parts) < 4 {
		return "", false
	}
	path := strings.TrimPrefix(parts[3], "b/")
	if path == "/dev/null" || path == "" {
		path = strings.TrimPrefix(parts[2], "a/")
	}
	return path, path != "" && path != "/dev/null"
}

func truncateTimelinePayload(value string) (string, bool) {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= timelinePayloadMaxRunes {
		return string(runes), false
	}
	return string(runes[:timelinePayloadMaxRunes]) + "\n...", true
}

func toolEventSummary(toolName string, input string) string {
	name := strings.TrimSpace(toolName)
	if name == "" {
		name = "Tool"
	}
	input = compactSummary(input)
	if input == "" {
		return name
	}
	return fmt.Sprintf("%s: %s", name, input)
}

func toolResultSummary(event agent.ProgressEvent) string {
	name := strings.TrimSpace(event.ToolName)
	if name == "" {
		name = "Tool"
	}
	status := strings.TrimSpace(event.ToolStatus)
	if event.ToolSuccess != nil {
		if *event.ToolSuccess {
			status = "succeeded"
		} else {
			status = "failed"
		}
	}
	if status == "" {
		status = "finished"
	}
	result := compactSummary(event.ToolResult)
	if result != "" {
		return fmt.Sprintf("%s: %s", name, result)
	}
	input := compactSummary(event.ToolInput)
	if input != "" {
		return fmt.Sprintf("%s: %s", name, input)
	}
	return fmt.Sprintf("%s %s", name, status)
}

func compactSummary(value string) string {
	normalized := strings.Join(strings.Fields(value), " ")
	return truncateRunes(normalized, 140)
}

func stringFromAny(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func intFromAny(value any) int {
	if number, ok := value.(int); ok {
		return number
	}
	return 0
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	return data
}

func (api *API) ensureWorktreeOnDisk(ctx context.Context, project model.Project, worktree model.Worktree) error {
	if _, err := os.Stat(worktree.Path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if strings.TrimSpace(worktree.Path) == "" {
		return fmt.Errorf("worktree path is required")
	}
	if err := os.MkdirAll(filepath.Dir(worktree.Path), 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	_ = exec.CommandContext(ctx, "git", "fetch", api.cfg.GitRemote, project.DefaultBranch).Run()
	cmd := exec.CommandContext(ctx, "git", "worktree", "add", "-B", worktree.Branch, worktree.Path, project.DefaultBranch)
	cmd.Dir = project.Path
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree add: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (api *API) ensureSessionForTarget(ctx context.Context, project model.Project, worktreeID string, title string, sessionModel string, initialPrompt string) (model.Session, error) {
	worktreeID = strings.TrimSpace(worktreeID)
	if existing, err := api.store.GetSessionByProjectWorktree(ctx, project.Slug, worktreeID); err == nil {
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return model.Session{}, err
	}
	if strings.TrimSpace(title) == "" {
		if worktreeID == "" {
			title = "Current branch"
		} else if wt, err := api.store.GetWorktree(ctx, worktreeID); err == nil {
			title = filepath.Base(wt.Path)
			if strings.TrimSpace(title) == "" || title == "." || title == string(filepath.Separator) {
				title = wt.Branch
			}
		} else {
			title = "Worktree"
		}
	}
	if strings.TrimSpace(sessionModel) == "" {
		sessionModel = api.defaultModel()
	}
	session := model.Session{
		ID:          id.New("ses"),
		ProjectSlug: project.Slug,
		Title:       truncateRunes(title, 80),
		Model:       sessionModel,
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
		WorktreeID:  worktreeID,
	}
	return api.store.CreateSession(ctx, session, strings.TrimSpace(initialPrompt))
}

func integrationPrompt(strategy string, project model.Project, worktree model.Worktree) string {
	return fmt.Sprintf(
		"Integrate the worktree branch into the workspace main branch using git %s.\n\nWorkspace: %s\nWorkspace path: %s\nTarget branch: %s\nWorktree branch: %s\nWorktree path: %s\nCommit: %s\n\nRun the required git checks first. Then %s the worktree branch into the target branch, resolve conflicts if needed, and report the final status. Do not push unless I explicitly ask.",
		strategy,
		project.Name,
		project.Path,
		project.DefaultBranch,
		worktree.Branch,
		worktree.Path,
		strings.TrimSpace(worktree.CommitSHA),
		strategy,
	)
}

func (api *API) normalizeModel(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return api.defaultModel(), true
	}
	for _, candidate := range api.availableModels() {
		if value == candidate {
			return value, true
		}
	}
	return "", false
}

func (api *API) defaultModel() string {
	if strings.TrimSpace(api.cfg.DefaultModel) != "" {
		return strings.TrimSpace(api.cfg.DefaultModel)
	}
	models := api.availableModels()
	if len(models) > 0 {
		return models[0]
	}
	return "gpt-5.4"
}

func (api *API) availableModels() []string {
	models := make([]string, 0, len(api.cfg.AvailableModels)+1)
	seen := make(map[string]bool)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		models = append(models, value)
	}
	add(api.cfg.DefaultModel)
	for _, value := range api.cfg.AvailableModels {
		add(value)
	}
	if len(models) == 0 {
		add("gpt-5.4")
	}
	return models
}

func (api *API) respondPermission(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Decision string `json:"decision"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	sessionID := chi.URLParam(r, "id")
	permissionID := chi.URLParam(r, "permissionID")
	permission, err := api.store.GetPermission(r.Context(), permissionID)
	if err != nil || permission.SessionID != sessionID {
		writeErrorMessage(w, http.StatusNotFound, "permission request not found")
		return
	}
	if permission.Status != "pending" {
		writeErrorMessage(w, http.StatusConflict, "permission request already resolved")
		return
	}
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, err)
		return
	}
	if session.Status != model.SessionStatusRunning {
		writeErrorMessage(w, http.StatusConflict, "permission request is not attached to an active run")
		return
	}
	decision := strings.ToLower(strings.TrimSpace(req.Decision))
	allow := decision == "allow"
	if !allow && decision != "deny" {
		writeErrorMessage(w, http.StatusBadRequest, "decision must be allow or deny")
		return
	}
	if api.agent == nil {
		writeErrorMessage(w, http.StatusServiceUnavailable, "agent runner is unavailable")
		return
	}
	if err := api.agent.RespondPermission(sessionID, permission.RequestID, allow); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	status := "denied"
	if allow {
		status = "allowed"
	}
	if err := api.store.UpdatePermissionStatus(r.Context(), permission.ID, status); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	api.addTimelineEvent(r.Context(), model.TimelineEvent{
		ID:        id.New("evt"),
		SessionID: sessionID,
		Kind:      "run_status",
		Title:     "Permission " + status,
		Summary:   permission.ToolName,
		Payload: mustJSON(map[string]any{
			"permissionId": permission.ID,
			"requestId":    permission.RequestID,
			"toolName":     permission.ToolName,
			"status":       status,
		}),
	})
	permission.Status = status
	writeJSON(w, http.StatusOK, permission)
}

func (api *API) getSessionGitDiff(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	detail, err := api.store.GetSessionDetail(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	gitPath := detail.Project.Path
	if detail.Worktree != nil {
		gitPath = detail.Worktree.Path
	}
	if _, err := os.Stat(gitPath); os.IsNotExist(err) {
		writeJSON(w, http.StatusOK, map[string]string{"diff": "", "type": "not_created"})
		return
	}

	// 1. Check for uncommitted diffs first
	out, err := commandOutput(gitPath, "git", "diff", "HEAD")
	if err == nil && len(strings.TrimSpace(out)) > 0 {
		writeJSON(w, http.StatusOK, map[string]string{
			"diff": out,
			"type": "uncommitted",
		})
		return
	}

	// 2. If no uncommitted diffs, check the latest commit (if any exists) vs origin/main's tip
	if detail.Worktree != nil && detail.Worktree.CommitSHA != "" {
		out, err = commandOutput(gitPath, "git", "show", detail.Worktree.CommitSHA)
		if err == nil && len(strings.TrimSpace(out)) > 0 {
			writeJSON(w, http.StatusOK, map[string]string{
				"diff": out,
				"type": "commit",
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"diff": "", "type": "empty"})
}

func (api *API) cors(next http.Handler) http.Handler {
	allowed := map[string]struct{}{}
	for _, origin := range api.cfg.AllowedOrigins {
		allowed[origin] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
	if err := decoder.Decode(target); err != nil {
		writeJSONDecodeError(w, err)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeJSONDecodeError(w, err)
		return false
	}
	return true
}

func writeJSONDecodeError(w http.ResponseWriter, err error) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		writeErrorMessage(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	writeErrorMessage(w, http.StatusBadRequest, "invalid JSON")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeErrorMessage(w, status, err.Error())
}

func writeErrorMessage(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"message": message})
}

func (api *API) projectDetail(ctx context.Context, project model.Project, activeWorktrees map[string]bool) (projectDetailResponse, error) {
	project = canonicalProjectPath(project)
	worktrees, err := api.store.ListWorktreesByProject(ctx, project.Slug)
	if err != nil {
		return projectDetailResponse{}, err
	}
	if activeWorktrees == nil {
		activeWorktrees, err = api.activeWorktreeIDs(ctx)
		if err != nil {
			return projectDetailResponse{}, err
		}
	}
	git := api.gitStatus(project)
	health := "clean"
	if !git.Reachable {
		health = "conflict"
	} else if git.DirtyFiles > 0 {
		health = "changes"
	} else if git.Behind > 0 {
		health = "behind"
	}
	return projectDetailResponse{
		Slug:          project.Slug,
		Name:          project.Name,
		Path:          project.Path,
		Description:   "Local project managed by Coding Broker.",
		Branch:        git.Branch,
		DefaultBranch: project.DefaultBranch,
		Health:        health,
		CreatedAt:     project.CreatedAt,
		UpdatedAt:     project.UpdatedAt,
		WorktreeCount: len(worktrees),
		Git:           git,
		Worktrees:     api.mapWorktrees(project, worktrees, activeWorktrees),
	}, nil
}

func (api *API) gitStatus(project model.Project) gitStatusResponse {
	project = canonicalProjectPath(project)
	return api.gitStatusForPath(project, project.Path)
}

func (api *API) gitStatusForPath(project model.Project, gitPath string) gitStatusResponse {
	branch := project.DefaultBranch
	reachable := true
	var statusMessage *string
	if _, err := os.Stat(gitPath); err != nil {
		reachable = false
		message := "project path is not accessible"
		statusMessage = &message
	}
	if reachable {
		if _, err := commandOutput(gitPath, "git", "rev-parse", "--is-inside-work-tree"); err != nil {
			reachable = false
			message := "project path is not a Git work tree"
			statusMessage = &message
		}
	}
	if output, err := commandOutput(gitPath, "git", "branch", "--show-current"); err == nil && strings.TrimSpace(output) != "" {
		branch = strings.TrimSpace(output)
	}
	dirtyFiles := 0
	if output, err := commandOutput(gitPath, "git", "status", "--porcelain"); err == nil && strings.TrimSpace(output) != "" {
		dirtyFiles = len(strings.Split(strings.TrimSpace(output), "\n"))
	}
	ahead, behind := 0, 0
	if output, err := commandOutput(gitPath, "git", "rev-list", "--left-right", "--count", fmt.Sprintf("origin/%s...%s", project.DefaultBranch, branch)); err == nil {
		left, right, parseErr := parseAheadBehind(output)
		if parseErr == nil {
			behind = left
			ahead = right
		}
	} else if output, err := commandOutput(gitPath, "git", "rev-list", "--left-right", "--count", fmt.Sprintf("%s...%s", project.DefaultBranch, branch)); err == nil {
		left, right, parseErr := parseAheadBehind(output)
		if parseErr == nil {
			behind = left
			ahead = right
		}
	}
	return gitStatusResponse{
		ProjectSlug:   project.Slug,
		Branch:        branch,
		DefaultBranch: project.DefaultBranch,
		Ahead:         ahead,
		Behind:        behind,
		DirtyFiles:    dirtyFiles,
		Reachable:     reachable,
		Message:       statusMessage,
	}
}

func (api *API) getCanonicalProject(ctx context.Context, slug string) (model.Project, error) {
	project, err := api.store.GetProject(ctx, slug)
	if err != nil {
		return model.Project{}, err
	}
	return canonicalProjectPath(project), nil
}

func canonicalProjectPath(project model.Project) model.Project {
	if resolvedPath, err := filepath.EvalSymlinks(project.Path); err == nil {
		project.Path = resolvedPath
	}
	return project
}

func parseAheadBehind(output string) (int, int, error) {
	parts := strings.Fields(output)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("unexpected rev-list output: %q", strings.TrimSpace(output))
	}
	left, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	right, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return left, right, nil
}

func commandOutput(dir string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	return string(output), err
}

func pathWithinBase(basePath string, targetPath string) bool {
	rel, err := filepath.Rel(basePath, targetPath)
	if err != nil {
		return false
	}
	return rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func validWorktreeName(name string) bool {
	return name != "." && name != ".." && !filepath.IsAbs(name) && !strings.ContainsAny(name, `/\`)
}

func directoryEntries(dirPath string, search string) ([]directoryEntryResponse, error) {
	search = strings.ToLower(strings.TrimSpace(search))
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	directories := make([]directoryEntryResponse, 0)
	for _, entry := range entries {
		name := entry.Name()
		if search != "" && !strings.Contains(strings.ToLower(name), search) {
			continue
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil || !info.IsDir() {
				continue
			}
		}
		fullPath := filepath.Join(dirPath, name)
		response := directoryEntryResponse{
			Name:          name,
			Path:          fullPath,
			Hidden:        strings.HasPrefix(name, "."),
			GitRepository: isGitRepository(fullPath),
		}
		if _, err := os.ReadDir(fullPath); err != nil {
			response.Unreadable = true
			response.PermissionError = err.Error()
		}
		directories = append(directories, response)
	}

	sortDirectoryEntryResponses(directories)
	return directories, nil
}

func sortDirectoryEntryResponses(entries []directoryEntryResponse) {
	sort.Slice(entries, func(i, j int) bool {
		left := strings.ToLower(entries[i].Name)
		right := strings.ToLower(entries[j].Name)
		if left == right {
			return entries[i].Name < entries[j].Name
		}
		return left < right
	})
}

func isGitRepository(dirPath string) bool {
	info, err := os.Stat(filepath.Join(dirPath, ".git"))
	return err == nil && (info.IsDir() || info.Mode().IsRegular())
}

func (api *API) activeWorktreeIDs(ctx context.Context) (map[string]bool, error) {
	sessions, err := api.store.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	activeWorktrees := make(map[string]bool)
	for _, session := range sessions {
		if session.WorktreeID != "" && isActiveSessionStatus(session.Status) {
			activeWorktrees[session.WorktreeID] = true
		}
	}
	return activeWorktrees, nil
}

func (api *API) mapWorktrees(project model.Project, worktrees []model.Worktree, activeWorktrees map[string]bool) []worktreeResponse {
	responses := make([]worktreeResponse, 0, len(worktrees))
	for _, worktree := range worktrees {
		responses = append(responses, api.mapWorktree(project, worktree, activeWorktrees))
	}
	return responses
}

func (api *API) mapWorktree(project model.Project, worktree model.Worktree, activeWorktrees map[string]bool) worktreeResponse {
	name := filepath.Base(worktree.Path)
	if name == "." || name == string(filepath.Separator) || name == "" {
		name = worktree.Branch
	}
	status := "ready"
	if activeWorktrees[worktree.ID] {
		status = "active"
	}
	git := api.gitStatusForPath(project, worktree.Path)
	if git.DirtyFiles > 0 && status != "active" {
		status = "dirty"
	}
	return worktreeResponse{
		ID:                worktree.ID,
		SessionID:         worktree.SessionID,
		ProjectSlug:       worktree.ProjectSlug,
		Name:              name,
		Branch:            worktree.Branch,
		Path:              worktree.Path,
		Status:            status,
		Git:               git,
		LastUsedAt:        worktree.UpdatedAt,
		CommitSHA:         worktree.CommitSHA,
		Pushed:            worktree.Pushed,
		PullRequestURL:    worktree.PullRequestURL,
		PullRequestNumber: worktree.PullRequestNumber,
	}
}

func mapSessions(sessions []model.Session) []sessionRecordResponse {
	responses := make([]sessionRecordResponse, 0, len(sessions))
	for _, session := range sessions {
		responses = append(responses, mapSession(session))
	}
	return responses
}

func mapSession(session model.Session) sessionRecordResponse {
	return sessionRecordResponse{
		Session:   session,
		Deletable: sessionDeletable(session),
	}
}

func sessionDeletable(session model.Session) bool {
	return strings.TrimSpace(session.WorktreeID) != ""
}

func (api *API) mapSessionDetail(detail model.SessionDetail) sessionDetailResponse {
	detail.Project = canonicalProjectPath(detail.Project)
	var worktree *worktreeResponse
	if detail.Worktree != nil {
		mapped := api.mapWorktree(detail.Project, *detail.Worktree, map[string]bool{detail.Worktree.ID: true})
		worktree = &mapped
	}
	return sessionDetailResponse{
		Session:        detail.Session,
		Project:        detail.Project,
		Messages:       detail.Messages,
		TimelineEvents: detail.TimelineEvents,
		Worktree:       worktree,
		Permissions:    detail.Permissions,
	}
}

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastDash := false
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			builder.WriteRune(char)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(builder.String(), "-")
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

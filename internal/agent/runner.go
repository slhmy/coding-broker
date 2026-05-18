package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	codexagent "github.com/chenhg5/cc-connect/agent/codex"
	"github.com/chenhg5/cc-connect/core"

	"github.com/slhmy/coding-broker/internal/config"
	"github.com/slhmy/coding-broker/internal/model"
)

var ErrIdleTimeout = errors.New("agent idle timeout")

const promptHistoryMessageLimit = 4000

type Runner struct {
	cfg      config.Config
	logger   *slog.Logger
	mu       sync.Mutex
	sessions map[string]*codexSessionState
}

type codexSessionState struct {
	agent   core.Agent
	session core.AgentSession
	mode    model.SessionMode
	model   string
	workDir string
}

type RespondResult struct {
	Content string `json:"content"`
}

type ProgressEvent struct {
	Kind        string
	Content     string
	RequestID   string
	ToolName    string
	ToolInput   string
	ToolResult  string
	ToolStatus  string
	ToolSuccess *bool
}

func NewRunner(cfg config.Config, logger *slog.Logger) *Runner {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	return &Runner{cfg: cfg, logger: logger, sessions: make(map[string]*codexSessionState)}
}

func (r *Runner) Respond(ctx context.Context, detail model.SessionDetail, userMessage string, onProgress func(ProgressEvent)) (RespondResult, error) {
	prompt := responsePrompt(detail, userMessage)
	session, err := r.codexSession(ctx, detail)
	if err != nil {
		return RespondResult{}, err
	}
	if err := session.Send(prompt, nil, nil); err != nil {
		return RespondResult{}, err
	}

	idleTimeout := r.cfg.AgentIdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = 10 * time.Minute
	}
	idleTimer := time.NewTimer(idleTimeout)
	defer idleTimer.Stop()

	var parts []string
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				r.closeCachedSession(detail.Session.ID, session)
				return RespondResult{}, fmt.Errorf("codex session closed")
			}
			resetTimer(idleTimer, idleTimeout)
			switch event.Type {
			case core.EventThinking:
				simpleProgress(onProgress, "thinking", event.Content)
			case core.EventToolUse:
				emitProgress(onProgress, ProgressEvent{
					Kind:      "tool_use",
					Content:   formatToolUse(event),
					ToolName:  strings.TrimSpace(event.ToolName),
					ToolInput: strings.TrimSpace(event.ToolInput),
				})
			case core.EventToolResult:
				emitProgress(onProgress, ProgressEvent{
					Kind:        "tool_result",
					Content:     formatToolResult(event),
					ToolName:    strings.TrimSpace(event.ToolName),
					ToolInput:   strings.TrimSpace(event.ToolInput),
					ToolResult:  strings.TrimSpace(event.ToolResult),
					ToolStatus:  strings.TrimSpace(event.ToolStatus),
					ToolSuccess: event.ToolSuccess,
				})
			case core.EventPermissionRequest:
				emitProgress(onProgress, ProgressEvent{
					Kind:      "permission",
					Content:   formatPermissionRequest(event),
					RequestID: event.RequestID,
					ToolName:  strings.TrimSpace(event.ToolName),
					ToolInput: strings.TrimSpace(event.ToolInput),
				})
			case core.EventText:
				if text := strings.TrimSpace(event.Content); text != "" {
					parts = append(parts, text)
				}
			case core.EventError:
				simpleProgress(onProgress, "error", errorMessage(event))
				r.closeCachedSession(detail.Session.ID, session)
				if event.Error != nil {
					return RespondResult{}, event.Error
				}
				return RespondResult{}, fmt.Errorf("codex returned an error")
			case core.EventResult:
				content := strings.TrimSpace(strings.Join(parts, "\n\n"))
				if content == "" {
					content = "Done."
				}
				return RespondResult{Content: content}, nil
			}
		case <-ctx.Done():
			r.closeCachedSession(detail.Session.ID, session)
			return RespondResult{}, ctx.Err()
		case <-idleTimer.C:
			r.closeCachedSession(detail.Session.ID, session)
			return RespondResult{}, fmt.Errorf("%w: no agent events for %s", ErrIdleTimeout, idleTimeout)
		}
	}
}

func resetTimer(timer *time.Timer, timeout time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(timeout)
}

func (r *Runner) RespondPermission(sessionID string, requestID string, allow bool) error {
	r.mu.Lock()
	state := r.sessions[sessionID]
	r.mu.Unlock()
	if state == nil || state.session == nil || !state.session.Alive() {
		return fmt.Errorf("active agent session not found")
	}
	behavior := "deny"
	if allow {
		behavior = "allow"
	}
	return state.session.RespondPermission(requestID, core.PermissionResult{Behavior: behavior})
}

func (r *Runner) CancelSession(sessionID string) bool {
	r.mu.Lock()
	state := r.sessions[sessionID]
	if state != nil {
		delete(r.sessions, sessionID)
	}
	r.mu.Unlock()

	if state == nil || state.session == nil {
		return false
	}

	_ = state.session.Close()
	return true
}

func (r *Runner) closeCachedSession(sessionID string, session core.AgentSession) {
	r.mu.Lock()
	if state := r.sessions[sessionID]; state != nil && state.session == session {
		delete(r.sessions, sessionID)
	}
	r.mu.Unlock()
	_ = session.Close()
}

func emitProgress(onProgress func(ProgressEvent), event ProgressEvent) {
	if onProgress == nil {
		return
	}
	event.Content = strings.TrimSpace(event.Content)
	if event.Content == "" {
		return
	}
	onProgress(event)
}

func simpleProgress(onProgress func(ProgressEvent), kind string, content string) {
	emitProgress(onProgress, ProgressEvent{Kind: kind, Content: content})
}

func formatToolUse(event core.Event) string {
	name := strings.TrimSpace(event.ToolName)
	input := truncateRunes(strings.TrimSpace(event.ToolInput), 1200)
	if name == "" {
		name = "Tool"
	}
	if input == "" {
		return fmt.Sprintf("Using %s", name)
	}
	return fmt.Sprintf("Using %s\n%s", name, input)
}

func formatToolResult(event core.Event) string {
	name := strings.TrimSpace(event.ToolName)
	if name == "" {
		name = "Tool"
	}
	status := strings.TrimSpace(event.ToolStatus)
	if event.ToolSuccess != nil {
		if *event.ToolSuccess {
			status = "succeeded"
		} else if status == "" {
			status = "failed"
		}
	}
	result := truncateRunes(strings.TrimSpace(event.ToolResult), 1200)
	if status == "" && result == "" {
		return fmt.Sprintf("%s finished", name)
	}
	if result == "" {
		return fmt.Sprintf("%s %s", name, status)
	}
	if status == "" {
		return fmt.Sprintf("%s result\n%s", name, result)
	}
	return fmt.Sprintf("%s %s\n%s", name, status, result)
}

func formatPermissionRequest(event core.Event) string {
	name := strings.TrimSpace(event.ToolName)
	if name == "" {
		name = "Permission"
	}
	input := truncateRunes(strings.TrimSpace(event.ToolInput), 1200)
	if input == "" {
		return fmt.Sprintf("Permission requested for %s", name)
	}
	return fmt.Sprintf("Permission requested for %s\n%s", name, input)
}

func errorMessage(event core.Event) string {
	if event.Error != nil {
		return event.Error.Error()
	}
	return strings.TrimSpace(event.Content)
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "..."
}

func (r *Runner) codexSession(ctx context.Context, detail model.SessionDetail) (core.AgentSession, error) {
	workDir := sessionWorkDir(detail)

	r.mu.Lock()
	state := r.sessions[detail.Session.ID]
	if state != nil && (!state.session.Alive() || state.mode != detail.Session.Mode || state.model != detail.Session.Model || state.workDir != workDir) {
		_ = state.session.Close()
		delete(r.sessions, detail.Session.ID)
		state = nil
	}
	if state != nil {
		session := state.session
		r.mu.Unlock()
		return session, nil
	}
	r.mu.Unlock()

	cliPath := codexCLIPath(r.cfg, detail.Session.Mode)
	opts := map[string]any{
		"work_dir": workDir,
		"mode":     codexMode(detail.Session.Mode),
		"cli_path": cliPath,
	}
	if strings.TrimSpace(detail.Session.Model) != "" {
		opts["model"] = strings.TrimSpace(detail.Session.Model)
	}
	agent, err := codexagent.New(opts)
	if err != nil {
		return nil, err
	}
	if injector, ok := agent.(core.SessionEnvInjector); ok {
		injector.SetSessionEnv(buildSessionEnv(r.cfg.CodexSessionEnvAllowlist, r.cfg.CodexSessionEnv))
	}
	session, err := agent.StartSession(ctx, "")
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.sessions[detail.Session.ID]; existing != nil {
		_ = session.Close()
		return existing.session, nil
	}
	r.sessions[detail.Session.ID] = &codexSessionState{agent: agent, session: session, mode: detail.Session.Mode, model: detail.Session.Model, workDir: workDir}
	return session, nil
}

func sessionWorkDir(detail model.SessionDetail) string {
	if detail.Worktree != nil {
		if path := strings.TrimSpace(detail.Worktree.Path); path != "" {
			return path
		}
	}
	return detail.Project.Path
}

func codexMode(mode model.SessionMode) string {
	return "suggest"
}

func codexCLIPath(cfg config.Config, mode model.SessionMode) string {
	parts := append([]string{cfg.CodexCommand}, cfg.CodexArgs...)
	if mode == model.SessionModeAct && !hasCodexSandboxArg(parts) {
		parts = append(parts, "--sandbox", "workspace-write")
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func hasCodexSandboxArg(args []string) bool {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if arg == "--sandbox" || arg == "-s" || strings.HasPrefix(arg, "--sandbox=") || arg == "--dangerously-bypass-approvals-and-sandbox" {
			return true
		}
	}
	return false
}

func selectSessionEnv(allowlist []string) []string {
	if len(allowlist) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(allowlist))
	env := make([]string, 0, len(allowlist))
	for _, key := range allowlist {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	sort.Strings(env)
	return env
}

func buildSessionEnv(allowlist []string, explicit []string) []string {
	merged := make(map[string]string, len(explicit))
	order := make([]string, 0, len(allowlist)+len(explicit))

	for _, entry := range selectSessionEnv(allowlist) {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		if _, seen := merged[key]; !seen {
			order = append(order, key)
		}
		merged[key] = value
	}
	for _, entry := range explicit {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		if _, seen := merged[key]; !seen {
			order = append(order, key)
		}
		merged[key] = value
	}

	env := make([]string, 0, len(order))
	for _, key := range order {
		env = append(env, key+"="+merged[key])
	}
	return env
}

func responsePrompt(detail model.SessionDetail, userMessage string) string {
	var builder strings.Builder
	latestUserMessage := strings.TrimSpace(userMessage)
	builder.WriteString("You are the real local coding agent for Coding Broker. Respond to the user's latest message using the repository at the working directory.\n")
	builder.WriteString(fmt.Sprintf("Project: %s (%s)\n", detail.Project.Name, detail.Project.Path))
	builder.WriteString(fmt.Sprintf("Working directory: %s\n", sessionWorkDir(detail)))
	builder.WriteString(fmt.Sprintf("Session mode: %s\n", detail.Session.Mode))
	if strings.TrimSpace(detail.Session.Model) != "" {
		builder.WriteString(fmt.Sprintf("Model: %s\n", strings.TrimSpace(detail.Session.Model)))
	}
	switch detail.Session.Mode {
	case model.SessionModePlan:
		builder.WriteString("Do not modify files, create branches, create worktrees, commit, or push in this mode.\n")
		builder.WriteString("Mode behavior: produce an implementation plan with concrete files, risks, and verification steps.\n")
	case model.SessionModeAct:
		builder.WriteString("Mode behavior: apply concrete changes when the user asks for them. You may edit files and run local verification commands in the current project.\n")
		builder.WriteString("Do not create a Git worktree unless the user explicitly asks for one. If the user asks you to commit, stage the relevant changes and create the commit yourself. Do not push unless explicitly requested.\n")
	default:
		builder.WriteString("Do not modify files, create branches, create worktrees, commit, or push in this mode.\n")
		builder.WriteString("Mode behavior: answer conversationally and help clarify or investigate the task.\n")
	}
	if len(detail.Messages) > 0 {
		builder.WriteString("\nRecent conversation:\n")
		start := 0
		if len(detail.Messages) > 12 {
			start = len(detail.Messages) - 12
		}
		historyMessages := detail.Messages[start:]
		lastHistoryIndex := -1
		for index, message := range historyMessages {
			if message.Role != "system" && strings.TrimSpace(message.Content) != "" {
				lastHistoryIndex = index
			}
		}
		for index, message := range historyMessages {
			if message.Role == "system" {
				continue
			}
			content := strings.TrimSpace(message.Content)
			if message.Role == "user" && index == lastHistoryIndex && content == latestUserMessage {
				continue
			}
			content = truncateRunes(content, promptHistoryMessageLimit)
			if content == "" {
				continue
			}
			builder.WriteString(fmt.Sprintf("%s: %s\n", message.Role, content))
		}
	}
	builder.WriteString("\nLatest user message:\n")
	builder.WriteString(latestUserMessage)
	builder.WriteString("\n")
	return builder.String()
}

func (r *Runner) run(ctx context.Context, dir string, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (r *Runner) output(ctx context.Context, dir string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

func (r *Runner) hasStagedChanges(ctx context.Context, dir string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "diff", "--cached", "--quiet")
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err == nil {
		return false, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return true, nil
	}
	return false, fmt.Errorf("git diff --cached --quiet: %w\n%s", err, strings.TrimSpace(string(output)))
}

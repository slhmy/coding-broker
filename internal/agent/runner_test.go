package agent

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chenhg5/cc-connect/core"

	"github.com/slhmy/coding-broker/internal/config"
	"github.com/slhmy/coding-broker/internal/model"
)

func TestSessionWorkDirPrefersWorktreePath(t *testing.T) {
	detail := model.SessionDetail{
		Project:  model.Project{Path: "/tmp/project"},
		Worktree: &model.Worktree{Path: "/tmp/worktree"},
	}

	if got := sessionWorkDir(detail); got != "/tmp/worktree" {
		t.Fatalf("expected worktree path, got %q", got)
	}
}

func TestSessionWorkDirFallsBackToProjectPath(t *testing.T) {
	detail := model.SessionDetail{Project: model.Project{Path: "/tmp/project"}}

	if got := sessionWorkDir(detail); got != "/tmp/project" {
		t.Fatalf("expected project path fallback, got %q", got)
	}
}

func TestCloseCachedSessionRemovesAndClosesMatchingSession(t *testing.T) {
	runner := NewRunner(config.Config{}, nil)
	session := &fakeAgentSession{events: make(chan core.Event)}
	runner.sessions["ses-close"] = &codexSessionState{session: session}

	runner.closeCachedSession("ses-close", session)

	if !session.closed {
		t.Fatal("expected session to be closed")
	}
	if _, ok := runner.sessions["ses-close"]; ok {
		t.Fatal("expected cached session to be removed")
	}
}

func TestCloseCachedSessionPreservesReplacementSession(t *testing.T) {
	runner := NewRunner(config.Config{}, nil)
	staleSession := &fakeAgentSession{events: make(chan core.Event)}
	replacementSession := &fakeAgentSession{events: make(chan core.Event)}
	runner.sessions["ses-close"] = &codexSessionState{session: replacementSession}

	runner.closeCachedSession("ses-close", staleSession)

	if !staleSession.closed {
		t.Fatal("expected stale session to be closed")
	}
	if runner.sessions["ses-close"].session != replacementSession {
		t.Fatal("expected replacement session to remain cached")
	}
	if replacementSession.closed {
		t.Fatal("expected replacement session to remain open")
	}
}

func TestResponsePromptTruncatesHistoryMessages(t *testing.T) {
	longContent := strings.Repeat("x", promptHistoryMessageLimit+100)
	prompt := responsePrompt(model.SessionDetail{
		Session: model.Session{Mode: model.SessionModeAsk},
		Project: model.Project{
			Name: "Sample App",
			Path: "/tmp/sample-app",
		},
		Messages: []model.Message{{
			Role:    "user",
			Content: longContent,
		}},
	}, "latest request")

	if strings.Contains(prompt, longContent) {
		t.Fatal("expected long history message to be truncated")
	}
	if !strings.Contains(prompt, strings.Repeat("x", promptHistoryMessageLimit)+"...") {
		t.Fatal("expected truncated history marker in prompt")
	}
	if !strings.Contains(prompt, "latest request") {
		t.Fatal("expected latest user message to remain in prompt")
	}
}

func TestResponsePromptSkipsBlankHistoryMessages(t *testing.T) {
	prompt := responsePrompt(model.SessionDetail{
		Session: model.Session{Mode: model.SessionModeAsk},
		Project: model.Project{
			Name: "Sample App",
			Path: "/tmp/sample-app",
		},
		Messages: []model.Message{{
			Role:    "user",
			Content: "   ",
		}},
	}, "latest request")

	if strings.Contains(prompt, "user: \n") {
		t.Fatal("expected blank history message to be skipped")
	}
	if !strings.Contains(prompt, "latest request") {
		t.Fatal("expected latest user message to remain in prompt")
	}
}

func TestResponsePromptSkipsDuplicateLatestHistoryMessage(t *testing.T) {
	prompt := responsePrompt(model.SessionDetail{
		Session: model.Session{Mode: model.SessionModeAsk},
		Project: model.Project{
			Name: "Sample App",
			Path: "/tmp/sample-app",
		},
		Messages: []model.Message{
			{Role: "assistant", Content: "previous reply"},
			{Role: "user", Content: "latest request"},
		},
	}, "latest request")

	if strings.Contains(prompt, "user: latest request") {
		t.Fatal("expected duplicate latest user message to be skipped from history")
	}
	if !strings.Contains(prompt, "assistant: previous reply") {
		t.Fatal("expected earlier history to remain in prompt")
	}
	if !strings.Contains(prompt, "Latest user message:\nlatest request") {
		t.Fatal("expected latest user message section to remain in prompt")
	}
}

func TestResponsePromptSkipsDuplicateLatestBeforeTrailingSystemMessage(t *testing.T) {
	prompt := responsePrompt(model.SessionDetail{
		Session: model.Session{Mode: model.SessionModeAsk},
		Project: model.Project{
			Name: "Sample App",
			Path: "/tmp/sample-app",
		},
		Messages: []model.Message{
			{Role: "assistant", Content: "previous reply"},
			{Role: "user", Content: "latest request"},
			{Role: "system", Content: "Agent started"},
		},
	}, "latest request")

	if strings.Contains(prompt, "user: latest request") {
		t.Fatal("expected duplicate latest user message before trailing system message to be skipped")
	}
	if !strings.Contains(prompt, "assistant: previous reply") {
		t.Fatal("expected earlier history to remain in prompt")
	}
}

func TestCodexModeDoesNotUseDeprecatedFullAuto(t *testing.T) {
	if got := codexMode(model.SessionModeAct); got != "suggest" {
		t.Fatalf("expected act mode to avoid deprecated full-auto, got %q", got)
	}
}

func TestCodexCLIPathAddsWorkspaceWriteSandboxForAct(t *testing.T) {
	got := codexCLIPath(config.Config{CodexCommand: "codex"}, model.SessionModeAct)
	want := "codex --sandbox workspace-write"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestCodexCLIPathPreservesExplicitSandboxArgs(t *testing.T) {
	got := codexCLIPath(config.Config{
		CodexCommand: "codex",
		CodexArgs:    []string{"--sandbox", "danger-full-access"},
	}, model.SessionModeAct)
	want := "codex --sandbox danger-full-access"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestCodexCLIPathDoesNotAddSandboxOutsideActMode(t *testing.T) {
	got := codexCLIPath(config.Config{CodexCommand: "codex"}, model.SessionModeAsk)
	if got != "codex" {
		t.Fatalf("expected ask mode cli path to remain plain, got %q", got)
	}
}

func TestHasStagedChanges(t *testing.T) {
	repoPath := initGitRepo(t)
	runner := NewRunner(config.Config{}, slog.New(slog.NewTextHandler(os.Stderr, nil)))

	hasChanges, err := runner.hasStagedChanges(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if hasChanges {
		t.Fatal("expected no staged changes")
	}

	if err := os.WriteFile(filepath.Join(repoPath, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoPath, "add", "README.md")

	hasChanges, err = runner.hasStagedChanges(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if !hasChanges {
		t.Fatal("expected staged changes")
	}
}

func TestSelectSessionEnvFiltersAllowlist(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://proxy.example:8080")
	t.Setenv("HTTPS_PROXY", "http://proxy.example:8443")
	t.Setenv("NO_PROXY", "localhost,127.0.0.1")
	t.Setenv("SECRET_TOKEN", "ignore-me")

	got := selectSessionEnv([]string{
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"NO_PROXY",
		"MISSING_VAR",
		"HTTPS_PROXY",
	})

	want := []string{
		"HTTPS_PROXY=http://proxy.example:8443",
		"HTTP_PROXY=http://proxy.example:8080",
		"NO_PROXY=localhost,127.0.0.1",
	}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

func TestBuildSessionEnvOverridesAllowlistedValuesWithExplicitEntries(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://proxy.example:8080")
	t.Setenv("HTTPS_PROXY", "http://proxy.example:8443")

	got := buildSessionEnv(
		[]string{"HTTP_PROXY", "HTTPS_PROXY"},
		[]string{"HTTPS_PROXY=http://override.example:9443", "NO_PROXY=localhost"},
	)

	want := []string{
		"HTTPS_PROXY=http://override.example:9443",
		"HTTP_PROXY=http://proxy.example:8080",
		"NO_PROXY=localhost",
	}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

type fakeAgentSession struct {
	events chan core.Event
	closed bool
}

func (s *fakeAgentSession) Send(string, []core.ImageAttachment, []core.FileAttachment) error {
	return nil
}

func (s *fakeAgentSession) RespondPermission(string, core.PermissionResult) error {
	return nil
}

func (s *fakeAgentSession) Events() <-chan core.Event {
	return s.events
}

func (s *fakeAgentSession) CurrentSessionID() string {
	return "fake"
}

func (s *fakeAgentSession) Alive() bool {
	return !s.closed
}

func (s *fakeAgentSession) Close() error {
	s.closed = true
	return nil
}

func initGitRepo(t *testing.T) string {
	t.Helper()

	repoPath := t.TempDir()
	runGit(t, repoPath, "init", "-b", "main")
	return repoPath
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(output))
	}
}

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

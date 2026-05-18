package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/slhmy/coding-broker/internal/model"
)

func TestOpenExpandsHomePath(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)

	st, err := Open("~/Library/coding-broker/broker.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	expectedPath := filepath.Join(homePath, "Library", "coding-broker", "broker.db")
	if _, err := os.Stat(expectedPath); err != nil {
		t.Fatalf("expected database at expanded path %q: %v", expectedPath, err)
	}
}

func TestOpenRejectsBlankPath(t *testing.T) {
	if _, err := Open("  "); err == nil {
		t.Fatal("expected blank database path error")
	}
}

func TestUpdateSessionFieldsReturnNotFound(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	if _, err := st.UpdateSessionMode(ctx, "missing", model.SessionModePlan); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdateSessionMode ErrNotFound, got %v", err)
	}
	if _, err := st.UpdateSessionModel(ctx, "missing", "gpt-5.4"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdateSessionModel ErrNotFound, got %v", err)
	}
	if _, err := st.UpdateSession(ctx, model.Session{ID: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdateSession ErrNotFound, got %v", err)
	}
	if err := st.UpdateSessionStatus(ctx, "missing", model.SessionStatusRunning, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdateSessionStatus ErrNotFound, got %v", err)
	}
}

func TestUpdateRelatedRecordsReturnNotFound(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	if err := st.UpdatePermissionStatus(ctx, "missing", "allowed"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdatePermissionStatus ErrNotFound, got %v", err)
	}
	if err := st.UpdateWorktreeResult(ctx, "missing", "abc123", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected UpdateWorktreeResult ErrNotFound, got %v", err)
	}
}

func TestSessionsHandleNullWorktreeID(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-null-worktree",
		ProjectSlug: project.Slug,
		Title:       "Null worktree",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(ctx, `update sessions set worktree_id = null where id = ?`, session.ID); err != nil {
		t.Fatal(err)
	}

	persisted, err := st.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.WorktreeID != "" {
		t.Fatalf("expected empty worktree id for null value, got %q", persisted.WorktreeID)
	}
	sessions, err := st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].WorktreeID != "" {
		t.Fatalf("expected list to normalize null worktree id, got %#v", sessions)
	}
	if err := st.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
}

func TestSavePermissionReturnsPersistedRecordOnRequestConflict(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-permission-upsert",
		ProjectSlug: project.Slug,
		Title:       "Permission upsert",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusRunning,
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	first, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-original",
		SessionID: session.ID,
		RequestID: "req-repeat",
		ToolName:  "shell",
		ToolInput: "git status",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-new",
		SessionID: session.ID,
		RequestID: "req-repeat",
		ToolName:  "shell",
		ToolInput: "git diff",
		Status:    "allowed",
	})
	if err != nil {
		t.Fatal(err)
	}

	if second.ID != first.ID {
		t.Fatalf("expected repeated request to return persisted permission ID %q, got %q", first.ID, second.ID)
	}
	if second.ToolInput != "git diff" || second.Status != "allowed" {
		t.Fatalf("expected repeated request to return updated persisted permission, got %#v", second)
	}
	if _, err := st.GetPermission(ctx, "perm-new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected conflicting permission ID not to be inserted, got %v", err)
	}
}

func TestSavePermissionDoesNotReopenResolvedPermission(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-permission-resolved",
		ProjectSlug: project.Slug,
		Title:       "Permission resolved",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusRunning,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-resolved",
		SessionID: session.ID,
		RequestID: "req-resolved",
		ToolName:  "shell",
		ToolInput: "git status",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdatePermissionStatus(ctx, permission.ID, "allowed"); err != nil {
		t.Fatal(err)
	}

	repeated, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-repeated",
		SessionID: session.ID,
		RequestID: "req-resolved",
		ToolName:  "shell",
		ToolInput: "git diff",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Status != "allowed" {
		t.Fatalf("expected resolved permission to remain allowed, got %#v", repeated)
	}
	if repeated.ToolInput != "git diff" {
		t.Fatalf("expected repeated event to refresh tool input, got %#v", repeated)
	}
}

func TestSavePermissionAllowsSameRequestIDAcrossSessions(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	firstSession, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-permission-first",
		ProjectSlug: project.Slug,
		Title:       "Permission first",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusRunning,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	secondSession, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-permission-second",
		ProjectSlug: project.Slug,
		Title:       "Permission second",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusRunning,
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	first, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-first",
		SessionID: firstSession.ID,
		RequestID: "req-shared",
		ToolName:  "shell",
		ToolInput: "git status",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-second",
		SessionID: secondSession.ID,
		RequestID: "req-shared",
		ToolName:  "shell",
		ToolInput: "git diff",
	})
	if err != nil {
		t.Fatal(err)
	}

	if first.ID != "perm-first" || second.ID != "perm-second" {
		t.Fatalf("expected permissions to remain session-scoped, got first=%#v second=%#v", first, second)
	}
	firstPermissions, err := st.ListPermissions(ctx, firstSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	secondPermissions, err := st.ListPermissions(ctx, secondSession.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPermissions) != 1 || firstPermissions[0].ID != first.ID {
		t.Fatalf("unexpected first session permissions: %#v", firstPermissions)
	}
	if len(secondPermissions) != 1 || secondPermissions[0].ID != second.ID {
		t.Fatalf("unexpected second session permissions: %#v", secondPermissions)
	}
}

func TestListPermissionsUsesStableTieBreaker(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-permission-order",
		ProjectSlug: project.Slug,
		Title:       "Permission order",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusRunning,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, permission := range []model.PermissionRequest{
		{ID: "perm-stable-b", SessionID: session.ID, RequestID: "req-stable-b", ToolName: "shell", ToolInput: "git diff"},
		{ID: "perm-stable-a", SessionID: session.ID, RequestID: "req-stable-a", ToolName: "shell", ToolInput: "git status"},
	} {
		if _, err := st.SavePermission(ctx, permission); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.db.ExecContext(ctx, `
		update permissions
		set created_at = datetime('2026-01-01T00:00:00Z')
		where session_id = ?
	`, session.ID); err != nil {
		t.Fatal(err)
	}

	permissions, err := st.ListPermissions(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(permissions) != 2 {
		t.Fatalf("expected two permissions, got %#v", permissions)
	}
	if permissions[0].ID != "perm-stable-a" || permissions[1].ID != "perm-stable-b" {
		t.Fatalf("expected ID tie-breaker order [perm-stable-a perm-stable-b], got %#v", permissions)
	}
}

func TestDeleteRecordsReturnNotFound(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	if err := st.DeleteSession(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected DeleteSession ErrNotFound, got %v", err)
	}
	if err := st.DeleteWorktree(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected DeleteWorktree ErrNotFound, got %v", err)
	}
}

func TestAddMessageReturnsNotFoundForMissingSession(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	_, err := st.AddMessage(ctx, model.Message{
		ID:        "msg-missing-session",
		SessionID: "missing",
		Role:      "user",
		Content:   "hello",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected AddMessage ErrNotFound, got %v", err)
	}

	messages, listErr := st.ListMessages(ctx, "missing")
	if listErr != nil {
		t.Fatal(listErr)
	}
	if len(messages) != 0 {
		t.Fatalf("expected no messages for missing session, got %#v", messages)
	}
}

func TestAddMessageMovesSessionToTopOfList(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, second := createSessionPair(t, st, "ses-first", "ses-second")

	sessions, err := st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != second.ID {
		t.Fatalf("expected newest created session first, got %#v", sessions)
	}

	if _, err := st.AddMessage(ctx, model.Message{
		ID:        "msg-first-recent",
		SessionID: first.ID,
		Role:      "user",
		Content:   "bring this session forward",
	}); err != nil {
		t.Fatal(err)
	}

	sessions, err = st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != first.ID {
		t.Fatalf("expected session with newest message first, got %#v", sessions)
	}
	if !sessions[0].UpdatedAt.After(sessions[1].UpdatedAt) {
		t.Fatalf("expected first session updatedAt to be newer than second, got %#v", sessions)
	}
}

func TestListMessagesUsesStableTieBreaker(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	session, _ := createSessionPair(t, st, "ses-message-order", "ses-message-other")
	for _, message := range []model.Message{
		{ID: "msg-stable-b", SessionID: session.ID, Role: "assistant", Content: "second id"},
		{ID: "msg-stable-a", SessionID: session.ID, Role: "user", Content: "first id"},
	} {
		if _, err := st.AddMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.db.ExecContext(ctx, `
		update messages
		set created_at = datetime('2026-01-01T00:00:00Z')
		where session_id = ?
	`, session.ID); err != nil {
		t.Fatal(err)
	}

	messages, err := st.ListMessages(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected two messages, got %#v", messages)
	}
	if messages[0].ID != "msg-stable-a" || messages[1].ID != "msg-stable-b" {
		t.Fatalf("expected ID tie-breaker order [msg-stable-a msg-stable-b], got %#v", messages)
	}
}

func TestUpdateSessionStatusMovesSessionToTopOfList(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, second := createSessionPair(t, st, "ses-status-first", "ses-status-second")

	sessions, err := st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != second.ID {
		t.Fatalf("expected newest created session first, got %#v", sessions)
	}

	if err := st.UpdateSessionStatus(ctx, first.ID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}

	sessions, err = st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != first.ID {
		t.Fatalf("expected status-updated session first, got %#v", sessions)
	}
	if sessions[0].Status != model.SessionStatusRunning {
		t.Fatalf("expected running status, got %#v", sessions[0])
	}
	if !sessions[0].UpdatedAt.After(sessions[1].UpdatedAt) {
		t.Fatalf("expected first session updatedAt to be newer than second, got %#v", sessions)
	}
}

func TestUpdateSessionMovesSessionToTopOfList(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, second := createSessionPair(t, st, "ses-update-first", "ses-update-second")

	sessions, err := st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != second.ID {
		t.Fatalf("expected newest created session first, got %#v", sessions)
	}

	updated, err := st.UpdateSession(ctx, model.Session{
		ID:    first.ID,
		Title: "Renamed first",
		Mode:  model.SessionModePlan,
		Model: "gpt-5.4-mini",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != "Renamed first" || updated.Mode != model.SessionModePlan || updated.Model != "gpt-5.4-mini" {
		t.Fatalf("expected updated fields, got %#v", updated)
	}

	sessions, err = st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != first.ID {
		t.Fatalf("expected updated session first, got %#v", sessions)
	}
	if !sessions[0].UpdatedAt.After(sessions[1].UpdatedAt) {
		t.Fatalf("expected first session updatedAt to be newer than second, got %#v", sessions)
	}
}

func TestUpdateSessionFieldMovesSessionToTopOfList(t *testing.T) {
	tests := []struct {
		name   string
		first  string
		second string
		update func(context.Context, *Store, string) (model.Session, error)
		assert func(*testing.T, model.Session)
	}{
		{
			name:   "mode",
			first:  "ses-mode-first",
			second: "ses-mode-second",
			update: func(ctx context.Context, st *Store, sessionID string) (model.Session, error) {
				return st.UpdateSessionMode(ctx, sessionID, model.SessionModeAct)
			},
			assert: func(t *testing.T, session model.Session) {
				t.Helper()
				if session.Mode != model.SessionModeAct {
					t.Fatalf("expected act mode, got %#v", session)
				}
			},
		},
		{
			name:   "model",
			first:  "ses-model-first",
			second: "ses-model-second",
			update: func(ctx context.Context, st *Store, sessionID string) (model.Session, error) {
				return st.UpdateSessionModel(ctx, sessionID, "gpt-5.4-mini")
			},
			assert: func(t *testing.T, session model.Session) {
				t.Helper()
				if session.Model != "gpt-5.4-mini" {
					t.Fatalf("expected updated model, got %#v", session)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := testStore(t)
			ctx := context.Background()

			first, second := createSessionPair(t, st, tt.first, tt.second)

			sessions, err := st.ListSessions(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(sessions) != 2 || sessions[0].ID != second.ID {
				t.Fatalf("expected newest created session first, got %#v", sessions)
			}

			updated, err := tt.update(ctx, st, first.ID)
			if err != nil {
				t.Fatal(err)
			}
			tt.assert(t, updated)

			sessions, err = st.ListSessions(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(sessions) != 2 || sessions[0].ID != first.ID {
				t.Fatalf("expected updated session first, got %#v", sessions)
			}
			if !sessions[0].UpdatedAt.After(sessions[1].UpdatedAt) {
				t.Fatalf("expected first session updatedAt to be newer than second, got %#v", sessions)
			}
		})
	}
}

func TestListSessionsUsesStableTieBreaker(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, second := createSessionPair(t, st, "ses-stable-a", "ses-stable-b")
	if _, err := st.db.ExecContext(ctx, `
		update sessions
		set updated_at = datetime('2026-01-01T00:00:00Z')
		where id in (?, ?)
	`, first.ID, second.ID); err != nil {
		t.Fatal(err)
	}

	sessions, err := st.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected two sessions, got %#v", sessions)
	}
	if sessions[0].ID != second.ID || sessions[1].ID != first.ID {
		t.Fatalf("expected ID tie-breaker order [%s %s], got %#v", second.ID, first.ID, sessions)
	}
}

func TestListProjectsUsesStableTieBreaker(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	for _, project := range []model.Project{
		{Slug: "project-a", Name: "Project A", Path: "/tmp/project-a", DefaultBranch: "main"},
		{Slug: "project-b", Name: "Project B", Path: "/tmp/project-b", DefaultBranch: "main"},
	} {
		if _, err := st.CreateProject(ctx, project); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.db.ExecContext(ctx, `
		update projects
		set updated_at = datetime('2026-01-01T00:00:00Z')
		where slug in ('project-a', 'project-b')
	`); err != nil {
		t.Fatal(err)
	}

	projects, err := st.ListProjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected two projects, got %#v", projects)
	}
	if projects[0].Slug != "project-b" || projects[1].Slug != "project-a" {
		t.Fatalf("expected slug tie-breaker order [project-b project-a], got %#v", projects)
	}
}

func TestListWorktreesUsesStableTieBreaker(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, worktree := range []model.Worktree{
		{ID: "wt-stable-a", ProjectSlug: project.Slug, Path: "/tmp/wt-a", Branch: "feature/a"},
		{ID: "wt-stable-b", ProjectSlug: project.Slug, Path: "/tmp/wt-b", Branch: "feature/b"},
	} {
		if _, err := st.SaveWorktree(ctx, worktree); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.db.ExecContext(ctx, `
		update worktrees
		set updated_at = datetime('2026-01-01T00:00:00Z')
		where id in ('wt-stable-a', 'wt-stable-b')
	`); err != nil {
		t.Fatal(err)
	}

	worktrees, err := st.ListWorktreesByProject(ctx, project.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("expected two worktrees, got %#v", worktrees)
	}
	if worktrees[0].ID != "wt-stable-b" || worktrees[1].ID != "wt-stable-a" {
		t.Fatalf("expected ID tie-breaker order [wt-stable-b wt-stable-a], got %#v", worktrees)
	}
}

func TestCreateProjectReturnsPersistedRecordOnSlugConflict(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Renamed App",
		Path:          "/tmp/renamed-app",
		DefaultBranch: "develop",
	})
	if err != nil {
		t.Fatal(err)
	}

	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("expected project createdAt to remain %v, got %v", first.CreatedAt, second.CreatedAt)
	}
	if second.UpdatedAt.Before(first.UpdatedAt) || second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("expected project updatedAt to advance from %v, got %v", first.UpdatedAt, second.UpdatedAt)
	}
	if second.Name != "Renamed App" || second.Path != "/tmp/renamed-app" || second.DefaultBranch != "develop" {
		t.Fatalf("expected updated persisted project, got %#v", second)
	}
}

func TestCreateProjectSameValuesPreservesUpdatedAtOnSlugConflict(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	first, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}

	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("expected project createdAt to remain %v, got %v", first.CreatedAt, second.CreatedAt)
	}
	if !second.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("expected identical project upsert to preserve updatedAt %v, got %v", first.UpdatedAt, second.UpdatedAt)
	}
}

func TestDeleteSessionCascadesMessages(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-cascade",
		ProjectSlug: project.Slug,
		Title:       "Cascade",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddMessage(ctx, model.Message{
		ID:        "msg-cascade",
		SessionID: session.ID,
		Role:      "user",
		Content:   "hello",
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	messages, err := st.ListMessages(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 0 {
		t.Fatalf("expected messages to be deleted, got %#v", messages)
	}
}

func TestDeleteSessionRemovesReferencedWorktree(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-worktree-reference",
		ProjectSlug: project.Slug,
		Title:       "Worktree reference",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAct,
		Status:      model.SessionStatusDone,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.SaveWorktree(ctx, model.Worktree{
		ID:          "wt-referenced",
		ProjectSlug: project.Slug,
		Path:        "/tmp/sample-app-worktree",
		Branch:      "feature/referenced",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(ctx, session.ID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetWorktree(ctx, worktree.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected referenced worktree to be deleted, got %v", err)
	}
}

func TestCreateSessionRejectsMissingProject(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	_, err := st.CreateSession(ctx, model.Session{
		ID:          "ses-missing-project",
		ProjectSlug: "missing-project",
		Title:       "Missing project",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err == nil {
		t.Fatal("expected missing project foreign key error")
	}
}

func TestSaveManualWorktreeAllowsEmptySession(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.SaveWorktree(ctx, model.Worktree{
		ID:          "wt-manual",
		ProjectSlug: project.Slug,
		Path:        "/tmp/sample-app-worktree",
		Branch:      "feature/manual",
	})
	if err != nil {
		t.Fatal(err)
	}
	if worktree.SessionID != "" {
		t.Fatalf("expected empty manual session ID, got %q", worktree.SessionID)
	}
}

func TestMigrateRemovesWorktreeSessionForeignKey(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "broker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}()

	if _, err := st.db.ExecContext(ctx, `pragma foreign_keys = off`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(ctx, `
		create table projects (
		  slug text primary key,
		  name text not null,
		  path text not null,
		  default_branch text not null,
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		create table sessions (
		  id text primary key,
		  project_slug text not null references projects(slug),
		  title text not null,
		  mode text not null,
		  status text not null,
		  worktree_id text not null default '',
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		create table worktrees (
		  id text primary key,
		  session_id text not null references sessions(id),
		  project_slug text not null references projects(slug),
		  path text not null,
		  branch text not null,
		  commit_sha text not null default '',
		  pushed integer not null default 0,
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		insert into projects (slug, name, path, default_branch, created_at, updated_at)
		values ('sample-app', 'Sample App', '/tmp/sample-app', 'main', datetime('now'), datetime('now'));
		insert into worktrees (id, session_id, project_slug, path, branch, created_at, updated_at)
		values ('wt-legacy-manual', 'manual', 'sample-app', '/tmp/sample-app-worktree', 'feature/manual', datetime('now'), datetime('now'));
	`); err != nil {
		t.Fatal(err)
	}

	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if hasWorktreeSessionReference(t, st) {
		t.Fatal("expected worktrees.session_id foreign key to be removed")
	}
	if _, err := st.SaveWorktree(ctx, model.Worktree{
		ID:          "wt-new-manual",
		ProjectSlug: "sample-app",
		Path:        "/tmp/sample-app-new-worktree",
		Branch:      "feature/new-manual",
	}); err != nil {
		t.Fatal(err)
	}
	worktrees, err := st.ListWorktreesByProject(ctx, "sample-app")
	if err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("expected legacy and new worktrees, got %#v", worktrees)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("expected second migrate to be idempotent: %v", err)
	}
	if hasWorktreeSessionReference(t, st) {
		t.Fatal("expected second migrate to keep worktrees.session_id foreign key removed")
	}
}

func TestMigrateMakesSessionWorktreeIDOptional(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "broker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}()

	if _, err := st.db.ExecContext(ctx, `
		create table projects (
		  slug text primary key,
		  name text not null,
		  path text not null,
		  default_branch text not null,
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		create table sessions (
		  id text primary key,
		  project_slug text not null references projects(slug),
		  title text not null,
		  model text not null default '',
		  mode text not null,
		  status text not null,
		  worktree_id text not null default '',
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		insert into projects (slug, name, path, default_branch, created_at, updated_at)
		values ('sample-app', 'Sample App', '/tmp/sample-app', 'main', datetime('now'), datetime('now'));
		insert into sessions (id, project_slug, title, model, mode, status, created_at, updated_at)
		values ('ses-legacy', 'sample-app', 'Legacy', 'gpt-5.4', 'ask', 'idle', datetime('now'), datetime('now'));
	`); err != nil {
		t.Fatal(err)
	}
	if !sessionWorktreeIDRequired(t, st) {
		t.Fatal("expected legacy sessions.worktree_id to be required before migration")
	}

	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if sessionWorktreeIDRequired(t, st) {
		t.Fatal("expected sessions.worktree_id to be optional after migration")
	}
	if _, err := st.db.ExecContext(ctx, `update sessions set worktree_id = null where id = 'ses-legacy'`); err != nil {
		t.Fatal(err)
	}
	session, err := st.GetSession(ctx, "ses-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if session.WorktreeID != "" {
		t.Fatalf("expected null worktree id to load as empty string, got %q", session.WorktreeID)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("expected second migrate to be idempotent: %v", err)
	}
	if sessionWorktreeIDRequired(t, st) {
		t.Fatal("expected second migrate to keep sessions.worktree_id optional")
	}
}

func TestMigrateScopesPermissionRequestUniquenessBySession(t *testing.T) {
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "broker.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}()

	if _, err := st.db.ExecContext(ctx, `
		create table projects (
		  slug text primary key,
		  name text not null,
		  path text not null,
		  default_branch text not null,
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		create table sessions (
		  id text primary key,
		  project_slug text not null references projects(slug),
		  title text not null,
		  mode text not null,
		  status text not null,
		  worktree_id text not null default '',
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		create table permissions (
		  id text primary key,
		  session_id text not null references sessions(id) on delete cascade,
		  request_id text not null unique,
		  tool_name text not null,
		  tool_input text not null,
		  status text not null,
		  created_at timestamp not null,
		  updated_at timestamp not null
		);
		insert into projects (slug, name, path, default_branch, created_at, updated_at)
		values ('sample-app', 'Sample App', '/tmp/sample-app', 'main', datetime('now'), datetime('now'));
		insert into sessions (id, project_slug, title, mode, status, created_at, updated_at)
		values
		  ('ses-one', 'sample-app', 'One', 'ask', 'running', datetime('now'), datetime('now')),
		  ('ses-two', 'sample-app', 'Two', 'ask', 'running', datetime('now'), datetime('now'));
		insert into permissions (id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at)
		values ('perm-one', 'ses-one', 'req-shared', 'shell', 'git status', 'pending', datetime('now'), datetime('now'));
	`); err != nil {
		t.Fatal(err)
	}

	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SavePermission(ctx, model.PermissionRequest{
		ID:        "perm-two",
		SessionID: "ses-two",
		RequestID: "req-shared",
		ToolName:  "shell",
		ToolInput: "git diff",
	}); err != nil {
		t.Fatal(err)
	}
	firstPermissions, err := st.ListPermissions(ctx, "ses-one")
	if err != nil {
		t.Fatal(err)
	}
	secondPermissions, err := st.ListPermissions(ctx, "ses-two")
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPermissions) != 1 || firstPermissions[0].ID != "perm-one" {
		t.Fatalf("unexpected first session permissions after migration: %#v", firstPermissions)
	}
	if len(secondPermissions) != 1 || secondPermissions[0].ID != "perm-two" {
		t.Fatalf("unexpected second session permissions after migration: %#v", secondPermissions)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("expected second migrate to be idempotent: %v", err)
	}
	secondPermissions, err = st.ListPermissions(ctx, "ses-two")
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPermissions) != 1 || secondPermissions[0].ID != "perm-two" {
		t.Fatalf("unexpected second session permissions after second migration: %#v", secondPermissions)
	}
}

func testStore(t *testing.T) *Store {
	t.Helper()

	st, err := Open(filepath.Join(t.TempDir(), "broker.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	})
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return st
}

func createSessionPair(t *testing.T, st *Store, firstID string, secondID string) (model.Session, model.Session) {
	t.Helper()
	ctx := context.Background()

	project, err := st.CreateProject(ctx, model.Project{
		Slug:          "sample-app",
		Name:          "Sample App",
		Path:          "/tmp/sample-app",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.CreateSession(ctx, model.Session{
		ID:          firstID,
		ProjectSlug: project.Slug,
		Title:       "First",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateSession(ctx, model.Session{
		ID:          secondID,
		ProjectSlug: project.Slug,
		Title:       "Second",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	return first, second
}

func hasWorktreeSessionReference(t *testing.T, st *Store) bool {
	t.Helper()

	rows, err := st.db.Query(`pragma foreign_key_list(worktrees)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	for rows.Next() {
		var id, seq int
		var tableName, fromColumn, toColumn, onUpdate, onDelete, match string
		if err := rows.Scan(&id, &seq, &tableName, &fromColumn, &toColumn, &onUpdate, &onDelete, &match); err != nil {
			t.Fatal(err)
		}
		if tableName == "sessions" && fromColumn == "session_id" {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return false
}

func sessionWorktreeIDRequired(t *testing.T, st *Store) bool {
	t.Helper()

	rows, err := st.db.Query(`pragma table_info(sessions)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			t.Fatal(err)
		}
		if name == "worktree_id" {
			return notNull == 1
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatal("sessions.worktree_id column not found")
	return false
}

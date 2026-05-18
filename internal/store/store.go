package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/slhmy/coding-broker/internal/model"
	"github.com/slhmy/coding-broker/internal/pathutil"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	path, err := pathutil.ExpandUser(path)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`pragma foreign_keys = on`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return err
	}
	if err := s.ensureSessionModelColumn(ctx); err != nil {
		return err
	}
	if err := s.ensureSessionWorktreeOptional(ctx); err != nil {
		return err
	}
	if err := s.ensurePermissionSessionRequestUnique(ctx); err != nil {
		return err
	}
	if err := s.ensureWorktreeSessionOptional(ctx); err != nil {
		return err
	}
	return s.ensureWorktreePRColumns(ctx)
}

func (s *Store) CreateProject(ctx context.Context, project model.Project) (model.Project, error) {
	now := time.Now().UTC()
	project.CreatedAt = now
	project.UpdatedAt = now
	if _, err := s.db.ExecContext(ctx, `
		insert into projects (slug, name, path, default_branch, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?)
		on conflict(slug) do update set
			name = excluded.name,
			path = excluded.path,
			default_branch = excluded.default_branch,
			updated_at = case
				when projects.name = excluded.name
					and projects.path = excluded.path
					and projects.default_branch = excluded.default_branch
				then projects.updated_at
				else excluded.updated_at
			end
	`, project.Slug, project.Name, project.Path, project.DefaultBranch, project.CreatedAt, project.UpdatedAt); err != nil {
		return model.Project{}, err
	}
	return s.GetProject(ctx, project.Slug)
}

func (s *Store) ListProjects(ctx context.Context) ([]model.Project, error) {
	rows, err := s.db.QueryContext(ctx, `select slug, name, path, default_branch, created_at, updated_at from projects order by updated_at desc, slug desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	projects := make([]model.Project, 0)
	for rows.Next() {
		var project model.Project
		if err := rows.Scan(&project.Slug, &project.Name, &project.Path, &project.DefaultBranch, &project.CreatedAt, &project.UpdatedAt); err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	return projects, rows.Err()
}

func (s *Store) CountProjects(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `select count(*) from projects`).Scan(&count)
	return count, err
}

func (s *Store) GetProject(ctx context.Context, slug string) (model.Project, error) {
	var project model.Project
	err := s.db.QueryRowContext(ctx, `select slug, name, path, default_branch, created_at, updated_at from projects where slug = ?`, slug).
		Scan(&project.Slug, &project.Name, &project.Path, &project.DefaultBranch, &project.CreatedAt, &project.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Project{}, ErrNotFound
	}
	return project, err
}

func (s *Store) CreateSession(ctx context.Context, session model.Session, initialMessage string) (model.Session, error) {
	now := time.Now().UTC()
	session.CreatedAt = now
	session.UpdatedAt = now
	err := tx(ctx, s.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			insert into sessions (id, project_slug, title, model, mode, status, worktree_id, created_at, updated_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, session.ID, session.ProjectSlug, session.Title, session.Model, session.Mode, session.Status, session.WorktreeID, session.CreatedAt, session.UpdatedAt); err != nil {
			return err
		}
		if initialMessage == "" {
			return nil
		}
		_, err := tx.ExecContext(ctx, `
			insert into messages (id, session_id, role, content, created_at)
			values (?, ?, 'user', ?, ?)
		`, fmt.Sprintf("msg_%d", now.UnixNano()), session.ID, initialMessage, now)
		return err
	})
	return session, err
}

func (s *Store) ListSessions(ctx context.Context) ([]model.Session, error) {
	rows, err := s.db.QueryContext(ctx, `select id, project_slug, title, model, mode, status, worktree_id, created_at, updated_at from sessions order by updated_at desc, id desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sessions := make([]model.Session, 0)
	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (s *Store) GetSession(ctx context.Context, id string) (model.Session, error) {
	row := s.db.QueryRowContext(ctx, `select id, project_slug, title, model, mode, status, worktree_id, created_at, updated_at from sessions where id = ?`, id)
	session, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Session{}, ErrNotFound
	}
	return session, err
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	return tx(ctx, s.db, func(tx *sql.Tx) error {
		var worktreeID sql.NullString
		if err := tx.QueryRowContext(ctx, `select worktree_id from sessions where id = ?`, id).Scan(&worktreeID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from permissions where session_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from messages where session_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from worktrees where session_id = ? or id = ?`, id, worktreeID.String); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `delete from sessions where id = ?`, id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Store) GetSessionDetail(ctx context.Context, id string) (model.SessionDetail, error) {
	session, err := s.GetSession(ctx, id)
	if err != nil {
		return model.SessionDetail{}, err
	}
	project, err := s.GetProject(ctx, session.ProjectSlug)
	if err != nil {
		return model.SessionDetail{}, err
	}
	messages, err := s.ListMessages(ctx, id)
	if err != nil {
		return model.SessionDetail{}, err
	}
	permissions, err := s.ListPermissions(ctx, id)
	if err != nil {
		return model.SessionDetail{}, err
	}
	detail := model.SessionDetail{Session: session, Project: project, Messages: messages, Permissions: permissions}
	if session.WorktreeID != "" {
		worktree, err := s.GetWorktree(ctx, session.WorktreeID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return model.SessionDetail{}, err
		}
		if err == nil {
			detail.Worktree = &worktree
		}
	}
	return detail, nil
}

func (s *Store) UpdateSessionMode(ctx context.Context, id string, mode model.SessionMode) (model.Session, error) {
	result, err := s.db.ExecContext(ctx, `update sessions set mode = ?, updated_at = ? where id = ?`, mode, time.Now().UTC(), id)
	if err != nil {
		return model.Session{}, err
	}
	if err := requireRowsAffected(result); err != nil {
		return model.Session{}, err
	}
	return s.GetSession(ctx, id)
}

func (s *Store) UpdateSessionModel(ctx context.Context, id string, sessionModel string) (model.Session, error) {
	result, err := s.db.ExecContext(ctx, `update sessions set model = ?, updated_at = ? where id = ?`, sessionModel, time.Now().UTC(), id)
	if err != nil {
		return model.Session{}, err
	}
	if err := requireRowsAffected(result); err != nil {
		return model.Session{}, err
	}
	return s.GetSession(ctx, id)
}

func (s *Store) UpdateSession(ctx context.Context, session model.Session) (model.Session, error) {
	result, err := s.db.ExecContext(ctx, `
		update sessions
		set title = ?, mode = ?, model = ?, updated_at = ?
		where id = ?
	`, session.Title, session.Mode, session.Model, time.Now().UTC(), session.ID)
	if err != nil {
		return model.Session{}, err
	}
	if err := requireRowsAffected(result); err != nil {
		return model.Session{}, err
	}
	return s.GetSession(ctx, session.ID)
}

func (s *Store) UpdateSessionStatus(ctx context.Context, id string, status model.SessionStatus, worktreeID string) error {
	result, err := s.db.ExecContext(ctx, `update sessions set status = ?, worktree_id = ?, updated_at = ? where id = ?`, status, worktreeID, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return requireRowsAffected(result)
}

func (s *Store) AddMessage(ctx context.Context, message model.Message) (model.Message, error) {
	message.CreatedAt = time.Now().UTC()
	err := tx(ctx, s.db, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `update sessions set updated_at = ? where id = ?`, message.CreatedAt, message.SessionID)
		if err != nil {
			return err
		}
		if err := requireRowsAffected(result); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `insert into messages (id, session_id, role, content, created_at) values (?, ?, ?, ?, ?)`, message.ID, message.SessionID, message.Role, message.Content, message.CreatedAt)
		return err
	})
	if err != nil {
		return model.Message{}, err
	}
	return message, nil
}

func (s *Store) ListMessages(ctx context.Context, sessionID string) ([]model.Message, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, role, content, created_at from messages where session_id = ? order by created_at asc, id asc`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]model.Message, 0)
	for rows.Next() {
		var message model.Message
		if err := rows.Scan(&message.ID, &message.SessionID, &message.Role, &message.Content, &message.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

func (s *Store) SavePermission(ctx context.Context, permission model.PermissionRequest) (model.PermissionRequest, error) {
	now := time.Now().UTC()
	permission.CreatedAt = now
	permission.UpdatedAt = now
	if permission.Status == "" {
		permission.Status = "pending"
	}
	if _, err := s.db.ExecContext(ctx, `
		insert into permissions (id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?)
		on conflict(session_id, request_id) do update set
			tool_name = excluded.tool_name,
			tool_input = excluded.tool_input,
			status = case
				when permissions.status = 'pending' then excluded.status
				else permissions.status
			end,
			updated_at = excluded.updated_at
	`, permission.ID, permission.SessionID, permission.RequestID, permission.ToolName, permission.ToolInput, permission.Status, permission.CreatedAt, permission.UpdatedAt); err != nil {
		return model.PermissionRequest{}, err
	}
	return s.getPermissionBySessionRequestID(ctx, permission.SessionID, permission.RequestID)
}

func (s *Store) ListPermissions(ctx context.Context, sessionID string) ([]model.PermissionRequest, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at from permissions where session_id = ? order by created_at asc, id asc`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	permissions := make([]model.PermissionRequest, 0)
	for rows.Next() {
		var permission model.PermissionRequest
		if err := rows.Scan(&permission.ID, &permission.SessionID, &permission.RequestID, &permission.ToolName, &permission.ToolInput, &permission.Status, &permission.CreatedAt, &permission.UpdatedAt); err != nil {
			return nil, err
		}
		permissions = append(permissions, permission)
	}
	return permissions, rows.Err()
}

func (s *Store) GetPermission(ctx context.Context, id string) (model.PermissionRequest, error) {
	var permission model.PermissionRequest
	err := s.db.QueryRowContext(ctx, `select id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at from permissions where id = ?`, id).
		Scan(&permission.ID, &permission.SessionID, &permission.RequestID, &permission.ToolName, &permission.ToolInput, &permission.Status, &permission.CreatedAt, &permission.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.PermissionRequest{}, ErrNotFound
	}
	return permission, err
}

func (s *Store) getPermissionBySessionRequestID(ctx context.Context, sessionID string, requestID string) (model.PermissionRequest, error) {
	var permission model.PermissionRequest
	err := s.db.QueryRowContext(ctx, `select id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at from permissions where session_id = ? and request_id = ?`, sessionID, requestID).
		Scan(&permission.ID, &permission.SessionID, &permission.RequestID, &permission.ToolName, &permission.ToolInput, &permission.Status, &permission.CreatedAt, &permission.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.PermissionRequest{}, ErrNotFound
	}
	return permission, err
}

func (s *Store) UpdatePermissionStatus(ctx context.Context, id string, status string) error {
	result, err := s.db.ExecContext(ctx, `update permissions set status = ?, updated_at = ? where id = ?`, status, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return requireRowsAffected(result)
}

func (s *Store) SaveWorktree(ctx context.Context, worktree model.Worktree) (model.Worktree, error) {
	now := time.Now().UTC()
	worktree.CreatedAt = now
	worktree.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		insert into worktrees (id, session_id, project_slug, path, branch, commit_sha, pushed, pull_request_url, pull_request_number, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, worktree.ID, worktree.SessionID, worktree.ProjectSlug, worktree.Path, worktree.Branch, worktree.CommitSHA, worktree.Pushed, worktree.PullRequestURL, worktree.PullRequestNumber, worktree.CreatedAt, worktree.UpdatedAt)
	return worktree, err
}

func (s *Store) ListWorktreesByProject(ctx context.Context, projectSlug string) ([]model.Worktree, error) {
	rows, err := s.db.QueryContext(ctx, `select id, session_id, project_slug, path, branch, commit_sha, pushed, pull_request_url, pull_request_number, created_at, updated_at from worktrees where project_slug = ? order by updated_at desc, id desc`, projectSlug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	worktrees := make([]model.Worktree, 0)
	for rows.Next() {
		var worktree model.Worktree
		if err := rows.Scan(&worktree.ID, &worktree.SessionID, &worktree.ProjectSlug, &worktree.Path, &worktree.Branch, &worktree.CommitSHA, &worktree.Pushed, &worktree.PullRequestURL, &worktree.PullRequestNumber, &worktree.CreatedAt, &worktree.UpdatedAt); err != nil {
			return nil, err
		}
		worktrees = append(worktrees, worktree)
	}
	return worktrees, rows.Err()
}

func (s *Store) DeleteWorktree(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `delete from worktrees where id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdateWorktreeResult(ctx context.Context, id string, commitSHA string, pushed bool) error {
	result, err := s.db.ExecContext(ctx, `update worktrees set commit_sha = ?, pushed = ?, updated_at = ? where id = ?`, commitSHA, pushed, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return requireRowsAffected(result)
}

func (s *Store) UpdateWorktreePR(ctx context.Context, id string, prURL string, prNumber int) error {
	result, err := s.db.ExecContext(ctx, `update worktrees set pull_request_url = ?, pull_request_number = ?, updated_at = ? where id = ?`, prURL, prNumber, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return requireRowsAffected(result)
}

func (s *Store) GetWorktree(ctx context.Context, id string) (model.Worktree, error) {
	var worktree model.Worktree
	err := s.db.QueryRowContext(ctx, `select id, session_id, project_slug, path, branch, commit_sha, pushed, pull_request_url, pull_request_number, created_at, updated_at from worktrees where id = ?`, id).
		Scan(&worktree.ID, &worktree.SessionID, &worktree.ProjectSlug, &worktree.Path, &worktree.Branch, &worktree.CommitSHA, &worktree.Pushed, &worktree.PullRequestURL, &worktree.PullRequestNumber, &worktree.CreatedAt, &worktree.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Worktree{}, ErrNotFound
	}
	return worktree, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSession(row scanner) (model.Session, error) {
	var session model.Session
	var worktreeID sql.NullString
	err := row.Scan(&session.ID, &session.ProjectSlug, &session.Title, &session.Model, &session.Mode, &session.Status, &worktreeID, &session.CreatedAt, &session.UpdatedAt)
	session.WorktreeID = worktreeID.String
	return session, err
}

func (s *Store) ensureSessionModelColumn(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `pragma table_info(sessions)`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == "model" {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `alter table sessions add column model text not null default ''`)
	return err
}

func (s *Store) ensureSessionWorktreeOptional(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `pragma table_info(sessions)`)
	if err != nil {
		return err
	}
	requiresMigration := false
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			_ = rows.Close()
			return err
		}
		if name == "worktree_id" && notNull == 1 {
			requiresMigration = true
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if !requiresMigration {
		return nil
	}

	if _, err := s.db.ExecContext(ctx, `pragma foreign_keys = off`); err != nil {
		return err
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), `pragma foreign_keys = on`)
	}()

	if err := tx(ctx, s.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			create table sessions_next (
			  id text primary key,
			  project_slug text not null references projects(slug),
			  title text not null,
			  model text not null default '',
			  mode text not null,
			  status text not null,
			  worktree_id text default '',
			  created_at timestamp not null,
			  updated_at timestamp not null
			)
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			insert into sessions_next (id, project_slug, title, model, mode, status, worktree_id, created_at, updated_at)
			select id, project_slug, title, model, mode, status, worktree_id, created_at, updated_at from sessions
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `drop table sessions`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `alter table sessions_next rename to sessions`)
		return err
	}); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `pragma foreign_keys = on`)
	return err
}

func (s *Store) ensurePermissionSessionRequestUnique(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `pragma index_list(permissions)`)
	if err != nil {
		return err
	}

	var uniqueIndexes []string
	for rows.Next() {
		var seq int
		var name, origin string
		var unique, partial int
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			_ = rows.Close()
			return err
		}
		if unique == 1 {
			uniqueIndexes = append(uniqueIndexes, name)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, name := range uniqueIndexes {
		columns, err := s.indexColumns(ctx, name)
		if err != nil {
			return err
		}
		if len(columns) == 2 && columns[0] == "session_id" && columns[1] == "request_id" {
			return nil
		}
	}

	if _, err := s.db.ExecContext(ctx, `pragma foreign_keys = off`); err != nil {
		return err
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), `pragma foreign_keys = on`)
	}()

	if err := tx(ctx, s.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			create table permissions_next (
				id text primary key,
				session_id text not null references sessions(id) on delete cascade,
				request_id text not null,
				tool_name text not null,
				tool_input text not null,
				status text not null,
				created_at timestamp not null,
				updated_at timestamp not null,
				unique(session_id, request_id)
			)
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			insert into permissions_next (id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at)
			select id, session_id, request_id, tool_name, tool_input, status, created_at, updated_at from permissions
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `drop table permissions`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `alter table permissions_next rename to permissions`)
		return err
	}); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `pragma foreign_keys = on`)
	return err
}

func (s *Store) indexColumns(ctx context.Context, indexName string) ([]string, error) {
	quotedName := strings.ReplaceAll(indexName, `"`, `""`)
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf(`pragma index_info("%s")`, quotedName))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []string
	for rows.Next() {
		var seqno, cid int
		var name string
		if err := rows.Scan(&seqno, &cid, &name); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func (s *Store) ensureWorktreeSessionOptional(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `pragma foreign_key_list(worktrees)`)
	if err != nil {
		return err
	}
	hasSessionReference := false
	for rows.Next() {
		var id, seq int
		var tableName, fromColumn, toColumn, onUpdate, onDelete, match string
		if err := rows.Scan(&id, &seq, &tableName, &fromColumn, &toColumn, &onUpdate, &onDelete, &match); err != nil {
			_ = rows.Close()
			return err
		}
		if tableName == "sessions" && fromColumn == "session_id" {
			hasSessionReference = true
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if !hasSessionReference {
		return nil
	}

	if _, err := s.db.ExecContext(ctx, `pragma foreign_keys = off`); err != nil {
		return err
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), `pragma foreign_keys = on`)
	}()

	if err := tx(ctx, s.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			create table worktrees_next (
			  id text primary key,
			  session_id text not null default '',
			  project_slug text not null references projects(slug),
			  path text not null,
			  branch text not null,
			  commit_sha text not null default '',
			  pushed integer not null default 0,
			  created_at timestamp not null,
			  updated_at timestamp not null
			)
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			insert into worktrees_next (id, session_id, project_slug, path, branch, commit_sha, pushed, created_at, updated_at)
			select id, session_id, project_slug, path, branch, commit_sha, pushed, created_at, updated_at from worktrees
		`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `drop table worktrees`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `alter table worktrees_next rename to worktrees`)
		return err
	}); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `pragma foreign_keys = on`)
	return err
}

func (s *Store) ensureWorktreePRColumns(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `pragma table_info(worktrees)`)
	if err != nil {
		return err
	}
	defer rows.Close()

	hasPullRequestURL := false
	hasPullRequestNumber := false
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == "pull_request_url" {
			hasPullRequestURL = true
		}
		if name == "pull_request_number" {
			hasPullRequestNumber = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if !hasPullRequestURL {
		if _, err := s.db.ExecContext(ctx, `alter table worktrees add column pull_request_url text not null default ''`); err != nil {
			return err
		}
	}
	if !hasPullRequestNumber {
		if _, err := s.db.ExecContext(ctx, `alter table worktrees add column pull_request_number integer not null default 0`); err != nil {
			return err
		}
	}
	return nil
}

func tx(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	txn, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(txn); err != nil {
		_ = txn.Rollback()
		return err
	}
	return txn.Commit()
}

func requireRowsAffected(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

const schema = `
create table if not exists projects (
  slug text primary key,
  name text not null,
  path text not null,
  default_branch text not null,
  created_at timestamp not null,
  updated_at timestamp not null
);

create table if not exists sessions (
  id text primary key,
  project_slug text not null references projects(slug),
  title text not null,
  model text not null default '',
  mode text not null,
  status text not null,
  worktree_id text default '',
  created_at timestamp not null,
  updated_at timestamp not null
);

create table if not exists messages (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamp not null
);

create table if not exists permissions (
	id text primary key,
	session_id text not null references sessions(id) on delete cascade,
	request_id text not null,
	tool_name text not null,
	tool_input text not null,
	status text not null,
	created_at timestamp not null,
	updated_at timestamp not null,
	unique(session_id, request_id)
);

create table if not exists worktrees (
  id text primary key,
  session_id text not null default '',
  project_slug text not null references projects(slug),
  path text not null,
  branch text not null,
  commit_sha text not null default '',
  pushed integer not null default 0,
  pull_request_url text not null default '',
  pull_request_number integer not null default 0,
  created_at timestamp not null,
  updated_at timestamp not null
);
`

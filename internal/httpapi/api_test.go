package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/slhmy/coding-broker/internal/agent"
	"github.com/slhmy/coding-broker/internal/config"
	"github.com/slhmy/coding-broker/internal/model"
	"github.com/slhmy/coding-broker/internal/store"
)

func TestCreateProjectValidatesGitWorkTree(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	body := bytes.NewBufferString(`{"name":"bad","path":"/path/that/does/not/exist"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, rec.Code)
	}
}

func TestCreateProjectRequiresPath(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name string
		body string
	}{
		{name: "missing path", body: `{"name":"Sample App"}`},
		{name: "blank path", body: `{"name":"Sample App","path":"  "}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/projects", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestWriteEndpointsRejectInvalidJSON(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "create project malformed", method: http.MethodPost, path: "/api/projects", body: `{`},
		{name: "create project trailing value", method: http.MethodPost, path: "/api/projects", body: `{"path":"/tmp"} {}`},
		{name: "create session", method: http.MethodPost, path: "/api/sessions", body: `{`},
		{name: "update session", method: http.MethodPatch, path: "/api/sessions/missing", body: `{`},
		{name: "update mode", method: http.MethodPatch, path: "/api/sessions/missing/mode", body: `{`},
		{name: "update model", method: http.MethodPatch, path: "/api/sessions/missing/model", body: `{`},
		{name: "send message", method: http.MethodPost, path: "/api/sessions/missing/messages", body: `{`},
		{name: "respond permission", method: http.MethodPost, path: "/api/sessions/missing/permissions/missing", body: `{`},
		{name: "create worktree", method: http.MethodPost, path: "/api/projects/missing/git/worktrees", body: `{`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "invalid JSON") {
				t.Fatalf("expected invalid JSON response, got %s", rec.Body.String())
			}
		})
	}
}

func TestWriteEndpointsRejectLargeJSONBodies(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	body := `{"projectSlug":"missing","prompt":"` + strings.Repeat("x", maxJSONBodyBytes) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected status %d, got %d: %s", http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "request body too large") {
		t.Fatalf("expected large body response, got %s", rec.Body.String())
	}
}

func TestListEndpointsReturnEmptyArrays(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	for _, path := range []string{"/api/projects", "/api/sessions"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s: expected status %d, got %d: %s", path, http.StatusOK, rec.Code, rec.Body.String())
		}
		if strings.TrimSpace(rec.Body.String()) != "[]" {
			t.Fatalf("%s: expected empty array, got %s", path, rec.Body.String())
		}
	}
}

func TestHealthzReturnsOK(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("expected nosniff header, got %q", got)
	}
	var response map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "ok" {
		t.Fatalf("expected health status ok, got %#v", response)
	}
}

func TestUnknownRoutesReturnJSONErrors(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name    string
		method  string
		path    string
		status  int
		message string
	}{
		{name: "not found", method: http.MethodGet, path: "/api/unknown", status: http.StatusNotFound, message: "not found"},
		{name: "method not allowed", method: http.MethodPut, path: "/healthz", status: http.StatusMethodNotAllowed, message: "method not allowed"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.status {
				t.Fatalf("expected status %d, got %d: %s", tt.status, rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("expected JSON content type, got %q", got)
			}
			var response map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if response["message"] != tt.message {
				t.Fatalf("expected message %q, got %#v", tt.message, response)
			}
		})
	}
}

func TestGetDetailEndpointsReturnNotFoundForMissingRecords(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name string
		path string
	}{
		{name: "project", path: "/api/projects/missing"},
		{name: "session", path: "/api/sessions/missing"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestGetConfigReturnsModelsAndPaths(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	handler, _, cleanup := testAPIWithConfig(t, config.Config{
		WorkspaceRoot: homePath,
		WorktreeRoot:  "~/broker-worktrees",
		DefaultModel:  "gpt-5.4",
	})
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response configResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.DefaultModel != "gpt-5.4" || len(response.AvailableModels) == 0 {
		t.Fatalf("unexpected config response: %#v", response)
	}
	expectedWorkspaceRoot := evalSymlinkPath(t, homePath)
	if response.WorkspaceRoot != expectedWorkspaceRoot {
		t.Fatalf("expected workspace root %q, got %q", expectedWorkspaceRoot, response.WorkspaceRoot)
	}
	expectedWorktreeRoot := filepath.Join(homePath, "broker-worktrees")
	if response.WorktreeRoot != expectedWorktreeRoot {
		t.Fatalf("expected worktree root %q, got %q", expectedWorktreeRoot, response.WorktreeRoot)
	}
}

func TestCORSPreflightAllowsConfiguredOrigin(t *testing.T) {
	handler, cleanup := testAPIWithAllowedOrigins(t, "http://localhost:5173")
	defer cleanup()

	req := httptest.NewRequest(http.MethodOptions, "/api/projects", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNoContent, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("expected allow origin header, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET,POST,PATCH,DELETE,OPTIONS" {
		t.Fatalf("expected allow methods header, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type, Accept" {
		t.Fatalf("expected allow headers header, got %q", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("expected vary origin header, got %q", got)
	}
}

func TestCORSPreflightOmitsHeadersForUnconfiguredOrigin(t *testing.T) {
	handler, cleanup := testAPIWithAllowedOrigins(t, "http://localhost:5173")
	defer cleanup()

	req := httptest.NewRequest(http.MethodOptions, "/api/projects", nil)
	req.Header.Set("Origin", "http://example.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNoContent, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no allow origin header, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "" {
		t.Fatalf("expected no allow methods header, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "" {
		t.Fatalf("expected no allow headers header, got %q", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("expected vary origin header, got %q", got)
	}
}

func TestCORSActualRequestAllowsConfiguredOrigin(t *testing.T) {
	handler, cleanup := testAPIWithAllowedOrigins(t, "http://localhost:5173")
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("expected allow origin header, got %q", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("expected vary origin header, got %q", got)
	}
}

func TestBrowseDirectoriesStartsAtHomeAndSearchesCurrentLevel(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	expectedHomePath := evalSymlinkPath(t, homePath)
	if err := os.Mkdir(filepath.Join(homePath, "alpha-app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(homePath, "beta-service"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(homePath, "notes.txt"), []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?search=alpha", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.HomePath != expectedHomePath || response.CurrentPath != expectedHomePath {
		t.Fatalf("expected home/current %q, got home=%q current=%q", expectedHomePath, response.HomePath, response.CurrentPath)
	}
	if len(response.Entries) != 1 || response.Entries[0].Name != "alpha-app" {
		t.Fatalf("expected alpha-app only, got %#v", response.Entries)
	}
}

func TestBrowseDirectoriesReturnsParentForChildDirectory(t *testing.T) {
	homePath := t.TempDir()
	childPath := filepath.Join(homePath, "child")
	t.Setenv("HOME", homePath)
	expectedHomePath := evalSymlinkPath(t, homePath)
	if err := os.Mkdir(childPath, 0o755); err != nil {
		t.Fatal(err)
	}
	expectedChildPath := evalSymlinkPath(t, childPath)

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?path="+url.QueryEscape(childPath), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.CurrentPath != expectedChildPath {
		t.Fatalf("expected current path %q, got %q", expectedChildPath, response.CurrentPath)
	}
	if response.ParentPath == nil || *response.ParentPath != expectedHomePath {
		t.Fatalf("expected parent path %q, got %#v", expectedHomePath, response.ParentPath)
	}
}

func TestBrowseDirectoriesMarksGitRepositoryEntries(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	repoPath := filepath.Join(homePath, "repo")
	if err := os.Mkdir(repoPath, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoPath, "init", "-b", "main")

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?search=repo", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if len(response.Entries) != 1 {
		t.Fatalf("expected one repo entry, got %#v", response.Entries)
	}
	if !response.Entries[0].GitRepository {
		t.Fatalf("expected gitRepository=true, got %#v", response.Entries[0])
	}
}

func TestBrowseDirectoriesMarksHiddenEntries(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	hiddenPath := filepath.Join(homePath, ".config")
	if err := os.Mkdir(hiddenPath, 0o755); err != nil {
		t.Fatal(err)
	}

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?search=.config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if len(response.Entries) != 1 {
		t.Fatalf("expected one hidden entry, got %#v", response.Entries)
	}
	if !response.Entries[0].Hidden {
		t.Fatalf("expected hidden=true, got %#v", response.Entries[0])
	}
}

func TestBrowseDirectoriesSortsEntriesCaseInsensitively(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	for _, name := range []string{"charlie", "Bravo", "alpha"} {
		if err := os.Mkdir(filepath.Join(homePath, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(response.Entries))
	for _, entry := range response.Entries {
		got = append(got, entry.Name)
	}
	want := []string{"alpha", "Bravo", "charlie"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("expected sorted entries %v, got %v", want, got)
	}
}

func TestBrowseDirectoriesSortsEqualLowercaseNamesByOriginalName(t *testing.T) {
	entries := []directoryEntryResponse{
		{Name: "alpha"},
		{Name: "Alpha"},
		{Name: "ALPHA"},
	}

	sortDirectoryEntryResponses(entries)

	got := make([]string, 0, len(entries))
	for _, entry := range entries {
		got = append(got, entry.Name)
	}
	want := []string{"ALPHA", "Alpha", "alpha"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("expected sorted entries %v, got %v", want, got)
	}
}

func TestBrowseDirectoriesRejectsPathsOutsideHome(t *testing.T) {
	homePath := t.TempDir()
	outsidePath := t.TempDir()
	t.Setenv("HOME", homePath)

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?path="+url.QueryEscape(outsidePath), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestBrowseDirectoriesUsesConfiguredWorkspaceRoot(t *testing.T) {
	homePath := t.TempDir()
	workspaceRoot := t.TempDir()
	t.Setenv("HOME", homePath)
	if err := os.Mkdir(filepath.Join(workspaceRoot, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}

	handler, _, cleanup := testAPIWithConfig(t, config.Config{WorkspaceRoot: workspaceRoot})
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	expectedRoot := evalSymlinkPath(t, workspaceRoot)
	if response.HomePath != expectedRoot || response.CurrentPath != expectedRoot {
		t.Fatalf("expected configured workspace root %q, got home=%q current=%q", expectedRoot, response.HomePath, response.CurrentPath)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/directories?path="+url.QueryEscape(homePath), nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected outside workspace status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestBrowseDirectoriesExpandsHomeWorkspaceRoot(t *testing.T) {
	homePath := t.TempDir()
	workspaceRoot := filepath.Join(homePath, "Code")
	repoPath := filepath.Join(workspaceRoot, "repo")
	t.Setenv("HOME", homePath)
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		t.Fatal(err)
	}
	handler, _, cleanup := testAPIWithConfig(t, config.Config{WorkspaceRoot: "~/Code"})
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	var response directoryBrowseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	expectedRoot := evalSymlinkPath(t, workspaceRoot)
	if response.HomePath != expectedRoot || response.CurrentPath != expectedRoot {
		t.Fatalf("expected expanded workspace root %q, got home=%q current=%q", expectedRoot, response.HomePath, response.CurrentPath)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/directories?path=~/Code/repo", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected nested status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	expectedRepoPath := evalSymlinkPath(t, repoPath)
	if response.CurrentPath != expectedRepoPath {
		t.Fatalf("expected expanded current path %q, got %q", expectedRepoPath, response.CurrentPath)
	}
}

func TestBrowseDirectoriesRejectsSymlinkOutsideHome(t *testing.T) {
	homePath := t.TempDir()
	outsidePath := t.TempDir()
	linkPath := filepath.Join(homePath, "outside-link")
	t.Setenv("HOME", homePath)
	if err := os.Symlink(outsidePath, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/directories?path="+url.QueryEscape(linkPath), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "path must be inside the workspace root") {
		t.Fatalf("expected outside workspace error, got %s", rec.Body.String())
	}
}

func TestBrowseDirectoriesRejectsMissingOrFilePath(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	filePath := filepath.Join(homePath, "notes.txt")
	if err := os.WriteFile(filePath, []byte("ignore"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name string
		path string
	}{
		{name: "missing", path: filepath.Join(homePath, "missing")},
		{name: "file", path: filePath},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/directories?path="+url.QueryEscape(tt.path), nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCreateProjectStoresReachableGitProject(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/sample-app", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	expectedRepoPath := evalSymlinkPath(t, repoPath)
	if response.Path != expectedRepoPath {
		t.Fatalf("expected canonical repo path %q, got %q", expectedRepoPath, response.Path)
	}
	if response.Description != "Local project managed by Coding Broker." {
		t.Fatalf("unexpected description %q", response.Description)
	}
	if response.CreatedAt.IsZero() {
		t.Fatal("expected createdAt to be set")
	}
	if response.UpdatedAt.IsZero() {
		t.Fatal("expected updatedAt to be set")
	}
	if response.WorktreeCount != 0 {
		t.Fatalf("expected no worktrees, got %d", response.WorktreeCount)
	}
	if len(response.Worktrees) != 0 {
		t.Fatalf("expected empty worktrees list, got %#v", response.Worktrees)
	}
	if response.Health != "clean" {
		t.Fatalf("expected health clean, got %q", response.Health)
	}
	if response.Git.ProjectSlug != "sample-app" {
		t.Fatalf("expected git project slug sample-app, got %q", response.Git.ProjectSlug)
	}
	if response.Git.DefaultBranch != "main" {
		t.Fatalf("expected git default branch main, got %q", response.Git.DefaultBranch)
	}
	if response.Git.Branch != "main" {
		t.Fatalf("expected git branch main, got %q", response.Git.Branch)
	}
	if response.Branch != response.Git.Branch {
		t.Fatalf("expected project branch to match git branch, got project=%q git=%q", response.Branch, response.Git.Branch)
	}
	if response.Git.DirtyFiles != 0 {
		t.Fatalf("expected no dirty files, got %d", response.Git.DirtyFiles)
	}
	if !response.Git.Reachable {
		t.Fatalf("expected reachable git status, got message %v", response.Git.Message)
	}
}

func TestCreateProjectStoresCanonicalSymlinkPath(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	linkPath := filepath.Join(t.TempDir(), "repo-link")
	if err := os.Symlink(repoPath, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	expectedPath := evalSymlinkPath(t, repoPath)
	body := bytes.NewBufferString(`{"name":"Linked App","path":` + quoteJSON(linkPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}
	var project model.Project
	if err := json.NewDecoder(rec.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	if project.Path != expectedPath {
		t.Fatalf("expected canonical repo path %q, got %q", expectedPath, project.Path)
	}
}

func TestCreateProjectExpandsHomePath(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	repoPath := filepath.Join(homePath, "sample-app")
	if err := os.Mkdir(repoPath, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoPath, "init", "-b", "main")
	handler, cleanup := testAPI(t)
	defer cleanup()

	body := bytes.NewBufferString(`{"name":"Home App","path":"~/sample-app","defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}
	var project model.Project
	if err := json.NewDecoder(rec.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	expectedPath := evalSymlinkPath(t, repoPath)
	if project.Path != expectedPath {
		t.Fatalf("expected expanded repo path %q, got %q", expectedPath, project.Path)
	}
}

func TestProjectDetailCanonicalizesLegacySymlinkPath(t *testing.T) {
	_, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	linkPath := filepath.Join(t.TempDir(), "repo-link")
	if err := os.Symlink(repoPath, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := st.CreateProject(context.Background(), model.Project{
		Slug:          "linked-app",
		Name:          "Linked App",
		Path:          linkPath,
		DefaultBranch: "main",
	}); err != nil {
		t.Fatal(err)
	}
	api := &API{store: st}
	response, err := api.projectDetail(context.Background(), model.Project{
		Slug:          "linked-app",
		Name:          "Linked App",
		Path:          linkPath,
		DefaultBranch: "main",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectedPath := evalSymlinkPath(t, repoPath)
	if response.Path != expectedPath {
		t.Fatalf("expected canonical repo path %q, got %q", expectedPath, response.Path)
	}
	if !response.Git.Reachable {
		t.Fatalf("expected reachable git status for canonical path, got %#v", response.Git)
	}
}

func TestListProjectsReturnsProjectDetails(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := createProject(t, handler)

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var projects []projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&projects); err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected one project, got %#v", projects)
	}
	project := projects[0]
	expectedRepoPath := evalSymlinkPath(t, repoPath)
	if project.Slug != "sample-app" || project.Path != expectedRepoPath {
		t.Fatalf("unexpected project detail: %#v", project)
	}
	if project.Description == "" || project.Git.ProjectSlug != "sample-app" {
		t.Fatalf("expected full project detail response, got %#v", project)
	}
	if project.CreatedAt.IsZero() || project.UpdatedAt.IsZero() {
		t.Fatalf("expected project timestamps to be set, got %#v", project)
	}
}

func TestListProjectsReturnsMultipleProjectDetails(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createNamedProject(t, handler, "Sample App")
	createNamedProject(t, handler, "Other App")

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var projects []projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&projects); err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected two projects, got %#v", projects)
	}
	if projects[0].Slug != "other-app" || projects[1].Slug != "sample-app" {
		t.Fatalf("expected newest project first, got %#v", projects)
	}
	seen := map[string]bool{}
	for _, project := range projects {
		seen[project.Slug] = project.Description != "" && project.Git.ProjectSlug == project.Slug
	}
	if !seen["sample-app"] || !seen["other-app"] {
		t.Fatalf("expected full details for both projects, got %#v", projects)
	}
}

func TestGetProjectMarksDirtyRepositoryAsChanges(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := createProject(t, handler)
	if err := os.WriteFile(filepath.Join(repoPath, "notes.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var project projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	if project.Health != "changes" {
		t.Fatalf("expected health changes, got %#v", project)
	}
	if project.Git.DirtyFiles != 1 {
		t.Fatalf("expected one dirty file, got %#v", project.Git)
	}
}

func TestGetProjectMarksMissingPathAsConflict(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := createProject(t, handler)
	if err := os.RemoveAll(repoPath); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var project projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	if project.Health != "conflict" {
		t.Fatalf("expected health conflict, got %#v", project)
	}
	if project.Git.Reachable {
		t.Fatalf("expected unreachable git status, got %#v", project.Git)
	}
	if project.Git.Message == nil || *project.Git.Message != "project path is not accessible" {
		t.Fatalf("expected missing path message, got %#v", project.Git.Message)
	}
}

func TestGetProjectMarksNonGitPathAsConflict(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	projectPath := t.TempDir()
	project, err := st.CreateProject(context.Background(), model.Project{
		Slug:          "plain-dir",
		Name:          "Plain Dir",
		Path:          projectPath,
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if project.Slug != "plain-dir" {
		t.Fatalf("unexpected project: %#v", project)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/plain-dir", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Health != "conflict" {
		t.Fatalf("expected health conflict, got %#v", response)
	}
	if response.Git.Reachable {
		t.Fatalf("expected unreachable git status, got %#v", response.Git)
	}
	if response.Git.Message == nil || *response.Git.Message != "project path is not a Git work tree" {
		t.Fatalf("expected non-git message, got %#v", response.Git.Message)
	}
}

func TestCreateProjectUsesDefaultNameAndBranch(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"path":` + quoteJSON(repoPath) + `}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var project model.Project
	if err := json.NewDecoder(rec.Body).Decode(&project); err != nil {
		t.Fatal(err)
	}
	if project.Name != filepath.Base(repoPath) {
		t.Fatalf("expected name %q, got %q", filepath.Base(repoPath), project.Name)
	}
	if project.DefaultBranch != "main" {
		t.Fatalf("expected default branch main, got %q", project.DefaultBranch)
	}
}

func TestCreateProjectReturnsProjectRecord(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"slug", "name", "path", "defaultBranch", "createdAt", "updatedAt"} {
		if _, ok := response[key]; !ok {
			t.Fatalf("expected project record key %q in %#v", key, response)
		}
	}
	for _, key := range []string{"description", "branch", "health", "worktreeCount", "git", "worktrees"} {
		if _, ok := response[key]; ok {
			t.Fatalf("did not expect project detail key %q in create response %#v", key, response)
		}
	}
}

func TestParseAheadBehind(t *testing.T) {
	ahead, behind, err := parseAheadBehind("3\t5\n")
	if err != nil {
		t.Fatal(err)
	}
	if ahead != 3 || behind != 5 {
		t.Fatalf("expected ahead/behind 3/5, got %d/%d", ahead, behind)
	}
	if _, _, err := parseAheadBehind("unexpected"); err == nil {
		t.Fatal("expected parse error")
	}
}

func TestSlugify(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{input: "Sample App", expected: "sample-app"},
		{input: " app__with   gaps ", expected: "app-with-gaps"},
		{input: "!!!", expected: ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := slugify(tt.input); got != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, got)
			}
		})
	}
}

func TestPathWithinBase(t *testing.T) {
	base := filepath.Join(string(filepath.Separator), "home", "demo")
	if !pathWithinBase(base, base) {
		t.Fatal("expected base path to be inside itself")
	}
	if !pathWithinBase(base, filepath.Join(base, "projects", "app")) {
		t.Fatal("expected child path to be inside base")
	}
	if pathWithinBase(base, filepath.Join(string(filepath.Separator), "home", "other")) {
		t.Fatal("expected sibling path to be outside base")
	}
}

func TestValidWorktreeName(t *testing.T) {
	valid := []string{"feature-one", "agent_123"}
	for _, name := range valid {
		if !validWorktreeName(name) {
			t.Fatalf("expected %q to be valid", name)
		}
	}

	invalid := []string{".", "..", "../escape", "nested/path", string(filepath.Separator) + "tmp"}
	for _, name := range invalid {
		if validWorktreeName(name) {
			t.Fatalf("expected %q to be invalid", name)
		}
	}
}

func TestCreateProjectRejectsNameWithoutSlugCharacters(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":"!!!","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestCreateProjectRejectsDefaultBranchWithWhitespace(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main branch"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestCreateProjectRejectsInvalidDefaultBranch(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"bad..branch"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestPullProjectReturnsPullMessage(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	remotePath := filepath.Join(t.TempDir(), "sample-app-origin.git")
	runGit(t, t.TempDir(), "init", "--bare", remotePath)
	runGit(t, repoPath, "remote", "add", "origin", remotePath)
	runGit(t, repoPath, "push", "-u", "origin", "main")
	createProjectBody := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", createProjectBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected project status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/pull", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected pull status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response gitStatusResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.PullMessage == nil || strings.TrimSpace(*response.PullMessage) == "" {
		t.Fatalf("unexpected pull message: %#v", response.PullMessage)
	}
	if response.LastPulledAt == nil {
		t.Fatal("expected lastPulledAt to be set")
	}
}

func TestPullProjectReturnsNotFoundForMissingProject(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/projects/missing/git/pull", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestDeleteSessionRemovesSession(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	createProjectBody := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", createProjectBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected project status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected delete status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected deleted session status %d, got %d", http.StatusNotFound, rec.Code)
	}
}

func TestDeleteSessionCancelsAgentAfterStoreDelete(t *testing.T) {
	runner := &fakeAgentRunner{}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+sessionID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected delete status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	if runner.cancelSessionID != sessionID {
		t.Fatalf("expected runner cancel for %q, got %#v", sessionID, runner)
	}
	if _, err := st.GetSession(context.Background(), sessionID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected store session to be deleted before cancel assertion, got %v", err)
	}
}

func TestDeleteSessionReturnsNotFoundForMissingSession(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodDelete, "/api/sessions/missing", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestListSessionsReturnsSessionRecords(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt_list_contract",
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "worktree"),
		Branch:      "feature/session-list",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()

	var sessions []struct {
		ID          string    `json:"id"`
		ProjectSlug string    `json:"projectSlug"`
		Title       string    `json:"title"`
		Model       string    `json:"model"`
		Mode        string    `json:"mode"`
		Status      string    `json:"status"`
		WorktreeID  string    `json:"worktreeId"`
		CreatedAt   time.Time `json:"createdAt"`
		UpdatedAt   time.Time `json:"updatedAt"`
	}
	if err := json.Unmarshal(body, &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected one session, got %#v", sessions)
	}
	session := sessions[0]
	if session.ID != sessionID || session.ProjectSlug != "sample-app" || session.Title != "test session" {
		t.Fatalf("unexpected session record: %#v", session)
	}
	if session.Model != "gpt-5.4" || session.Mode != string(model.SessionModeAsk) || session.Status != string(model.SessionStatusDone) {
		t.Fatalf("unexpected session state: %#v", session)
	}
	if session.WorktreeID != worktree.ID {
		t.Fatalf("expected worktreeId %q, got %q", worktree.ID, session.WorktreeID)
	}
	if session.CreatedAt.IsZero() || session.UpdatedAt.IsZero() {
		t.Fatalf("expected createdAt and updatedAt to be set: %#v", session)
	}

	var raw []map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	for _, detailOnlyField := range []string{"messages", "permissions", "plan", "changes", "project", "worktree"} {
		if _, ok := raw[0][detailOnlyField]; ok {
			t.Fatalf("expected list session record to omit %q, got %#v", detailOnlyField, raw[0])
		}
	}
}

func TestListSessionsPreservesStoreOrder(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	firstID := createTestSession(t, handler)
	secondID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), firstID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var sessions []struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected two sessions, got %#v", sessions)
	}
	if sessions[0].ID != firstID || sessions[1].ID != secondID {
		t.Fatalf("expected store order [%s %s], got %#v", firstID, secondID, sessions)
	}
}

func TestGetSessionReturnsSessionDetail(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sessionID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()

	var detail struct {
		Session struct {
			ID          string `json:"id"`
			ProjectSlug string `json:"projectSlug"`
			WorktreeID  string `json:"worktreeId"`
		} `json:"session"`
		Project struct {
			Slug          string `json:"slug"`
			Name          string `json:"name"`
			Path          string `json:"path"`
			DefaultBranch string `json:"defaultBranch"`
		} `json:"project"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Session.ID != sessionID || detail.Session.ProjectSlug != "sample-app" {
		t.Fatalf("unexpected session detail: %#v", detail.Session)
	}
	if detail.Project.Slug != "sample-app" || detail.Project.Name != "Sample App" || detail.Project.DefaultBranch != "main" {
		t.Fatalf("unexpected project detail: %#v", detail.Project)
	}
	if detail.Project.Path == "" || detail.Project.Path != evalSymlinkPath(t, detail.Project.Path) {
		t.Fatalf("expected canonical project path in session detail, got %q", detail.Project.Path)
	}
	if len(detail.Messages) == 0 || detail.Messages[0].Role != "user" || detail.Messages[0].Content != "test session" {
		t.Fatalf("unexpected messages: %#v", detail.Messages)
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	worktreeRaw, ok := raw["worktree"].(map[string]any)
	if !ok {
		t.Fatalf("expected session-owned worktree in response, got %#v", raw)
	}
	if worktreeRaw["id"] != detail.Session.WorktreeID {
		t.Fatalf("expected worktree %q, got %#v", detail.Session.WorktreeID, worktreeRaw)
	}
}

func TestGetSessionReturnsStableMessageAndPermissionOrder(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	for _, message := range []model.Message{
		{ID: "msg-detail-b", SessionID: sessionID, Role: "assistant", Content: "second id"},
		{ID: "msg-detail-a", SessionID: sessionID, Role: "user", Content: "first id"},
	} {
		if _, err := st.AddMessage(context.Background(), message); err != nil {
			t.Fatal(err)
		}
	}
	for _, permission := range []model.PermissionRequest{
		{ID: "perm-detail-b", SessionID: sessionID, RequestID: "req-detail-b", ToolName: "shell", ToolInput: "git diff"},
		{ID: "perm-detail-a", SessionID: sessionID, RequestID: "req-detail-a", ToolName: "shell", ToolInput: "git status"},
	} {
		if _, err := st.SavePermission(context.Background(), permission); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sessionID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
		Permissions []struct {
			ID string `json:"id"`
		} `json:"permissions"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Messages) < 3 {
		t.Fatalf("expected initial and added messages, got %#v", detail.Messages)
	}
	if detail.Messages[1].ID != "msg-detail-b" || detail.Messages[2].ID != "msg-detail-a" {
		t.Fatalf("expected chronological message order after initial prompt, got %#v", detail.Messages)
	}
	if len(detail.Permissions) != 2 {
		t.Fatalf("expected two permissions, got %#v", detail.Permissions)
	}
	if detail.Permissions[0].ID != "perm-detail-b" || detail.Permissions[1].ID != "perm-detail-a" {
		t.Fatalf("expected chronological permission order, got %#v", detail.Permissions)
	}
}

func TestGetSessionReturnsPublicWorktreeResponse(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-session-detail",
		SessionID:   sessionID,
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "session-detail-worktree"),
		Branch:      "feature/session-detail",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sessionID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail struct {
		Worktree map[string]any `json:"worktree"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "projectSlug", "name", "branch", "path", "status", "lastUsedAt"} {
		if _, ok := detail.Worktree[key]; !ok {
			t.Fatalf("expected session worktree response to include %q, got %#v", key, detail.Worktree)
		}
	}
	if detail.Worktree["status"] != "active" {
		t.Fatalf("expected active worktree status, got %#v", detail.Worktree)
	}
	for _, key := range []string{"sessionId", "createdAt", "updatedAt"} {
		if _, ok := detail.Worktree[key]; ok {
			t.Fatalf("expected session worktree response to omit internal field %q, got %#v", key, detail.Worktree)
		}
	}
	if pushed, ok := detail.Worktree["pushed"].(bool); !ok || pushed {
		t.Fatalf("expected pushed=false in public response, got %#v", detail.Worktree)
	}
}

func TestDeleteSessionRemovesReferencedWorktree(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-delete-session",
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "delete-session-worktree"),
		Branch:      "feature/delete-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+sessionID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected delete status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	if _, err := st.GetWorktree(context.Background(), worktree.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected referenced worktree to be deleted, got %v", err)
	}
}

func TestCancelSessionMarksSessionIdle(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	createProjectBody := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", createProjectBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected project status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/sessions/"+session.ID+"/cancel", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected cancel status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail struct {
		Session struct {
			Status string `json:"status"`
		} `json:"session"`
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if detail.Session.Status != "idle" {
		t.Fatalf("expected idle status, got %q", detail.Session.Status)
	}
	if len(detail.Messages) == 0 || !strings.Contains(detail.Messages[len(detail.Messages)-1].Content, "Agent canceled") {
		t.Fatalf("expected cancel message, got %#v", detail.Messages)
	}
}

func TestCancelSessionCancelsRunnerAndPreservesWorktree(t *testing.T) {
	runner := &fakeAgentRunner{}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-cancel",
		SessionID:   sessionID,
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "cancel-worktree"),
		Branch:      "feature/cancel",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/cancel", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected cancel status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if runner.cancelSessionID != sessionID {
		t.Fatalf("expected runner cancel for %q, got %#v", sessionID, runner)
	}
	session, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != model.SessionStatusIdle || session.WorktreeID != worktree.ID {
		t.Fatalf("expected cancel to preserve worktree and mark idle, got %#v", session)
	}
}

func TestCancelSessionReturnsClosedFalseWhenRunnerHadNoSession(t *testing.T) {
	runner := &fakeAgentRunner{cancelResult: false}
	handler, _, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/cancel", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected cancel status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response struct {
		OK     bool `json:"ok"`
		Closed bool `json:"closed"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Closed {
		t.Fatalf("expected ok true and closed false, got %#v", response)
	}
}

func TestCancelSessionReturnsNotFoundForMissingSession(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/missing/cancel", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestAgentEndpointsReturnUnavailableWhenRunnerMissing(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-missing-runner",
		SessionID: sessionID,
		RequestID: "req-missing-runner",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	agentEndpoints := []struct {
		name string
		path string
		body string
	}{
		{name: "message", path: "/api/sessions/" + sessionID + "/messages", body: `{"content":"hello"}`},
	}

	for _, tt := range agentEndpoints {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tt.path, bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("expected status %d, got %d: %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
			}
		})
	}

	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d: %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
}

func TestAddMessageRejectsActiveSession(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d: %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
}

func TestAddMessageRequiresContent(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	tests := []struct {
		name string
		body string
	}{
		{name: "missing content", body: `{}`},
		{name: "blank content", body: `{"content":"  "}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAddMessageReturnsNotFoundForMissingSession(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/missing/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestAddMessageAcceptsAndStartsAgentRun(t *testing.T) {
	agent := &fakeAgentRunner{
		respondStarted: make(chan struct{}),
		releaseRespond: make(chan struct{}),
	}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, agent)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-message-existing",
		SessionID:   sessionID,
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "message-existing-worktree"),
		Branch:      "feature/message-existing",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var messages []model.Message
	if err := json.NewDecoder(rec.Body).Decode(&messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Content != "hello" || messages[0].Role != "user" {
		t.Fatalf("unexpected accepted messages: %#v", messages)
	}

	session, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != model.SessionStatusRunning {
		t.Fatalf("expected session to be running while agent responds, got %q", session.Status)
	}
	close(agent.releaseRespond)
	session = waitForSessionStatus(t, st, sessionID, model.SessionStatusDone)
	if session.WorktreeID != worktree.ID {
		t.Fatalf("expected message run to preserve worktree %q, got %#v", worktree.ID, session)
	}
	persistedMessages, err := st.ListMessages(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(persistedMessages) == 0 || persistedMessages[len(persistedMessages)-1].Role != "assistant" || persistedMessages[len(persistedMessages)-1].Content != "done" {
		t.Fatalf("expected final assistant response to be saved, got %#v", persistedMessages)
	}
}

func TestAddMessageTrimsContent(t *testing.T) {
	agent := &fakeAgentRunner{
		respondStarted: make(chan struct{}),
		releaseRespond: make(chan struct{}),
	}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, agent)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"  hello  "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var messages []model.Message
	if err := json.NewDecoder(rec.Body).Decode(&messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Content != "hello" {
		t.Fatalf("expected trimmed accepted message, got %#v", messages)
	}

	close(agent.releaseRespond)
	waitForSessionStatus(t, st, sessionID, model.SessionStatusDone)
	if agent.respondUserMessage != "hello" {
		t.Fatalf("expected agent to receive trimmed content, got %q", agent.respondUserMessage)
	}
	if len(agent.respondMessages) == 0 || agent.respondMessages[len(agent.respondMessages)-1].Content == "hello" {
		t.Fatalf("expected agent history to exclude latest message, got %#v", agent.respondMessages)
	}
}

func TestAddMessageCanonicalizesLegacySymlinkProjectPath(t *testing.T) {
	agent := &fakeAgentRunner{
		respondStarted: make(chan struct{}),
		releaseRespond: make(chan struct{}),
	}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, agent)
	defer cleanup()

	repoPath := initGitRepo(t)
	linkPath := filepath.Join(t.TempDir(), "repo-link")
	if err := os.Symlink(repoPath, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := st.CreateProject(context.Background(), model.Project{
		Slug:          "linked-app",
		Name:          "Linked App",
		Path:          linkPath,
		DefaultBranch: "main",
	}); err != nil {
		t.Fatal(err)
	}
	session, err := st.CreateSession(context.Background(), model.Session{
		ID:          "ses-linked-message",
		ProjectSlug: "linked-app",
		Title:       "Linked message",
		Model:       "gpt-5.4",
		Mode:        model.SessionModeAsk,
		Status:      model.SessionStatusIdle,
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+session.ID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}
	<-agent.respondStarted
	close(agent.releaseRespond)
	waitForSessionStatus(t, st, session.ID, model.SessionStatusDone)
	expectedPath := evalSymlinkPath(t, repoPath)
	if agent.respondProjectPath != expectedPath {
		t.Fatalf("expected runner project path %q, got %q", expectedPath, agent.respondProjectPath)
	}
}

func TestAddMessageMarksFailedWhenRunnerFails(t *testing.T) {
	agent := &fakeAgentRunner{respondErr: errors.New("respond exploded")}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, agent)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitForSessionStatus(t, st, sessionID, model.SessionStatusFailed)
	messages, err := st.ListMessages(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) == 0 || !strings.Contains(messages[len(messages)-1].Content, "Agent run failed: respond exploded") {
		t.Fatalf("expected agent failure message, got %#v", messages)
	}
}

func TestAddMessageRunnerFailureDoesNotRequireLoggerDependency(t *testing.T) {
	agent := &fakeAgentRunner{respondErr: errors.New("respond exploded")}
	handler, st, cleanup := testAPIWithStoreAndAgentOptions(t, agent, nil)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitForSessionStatus(t, st, sessionID, model.SessionStatusFailed)
}

func TestAddMessageSavesPermissionProgressEvent(t *testing.T) {
	agent := &fakeAgentRunner{
		progressEvents: []agent.ProgressEvent{{
			Kind:      "permission",
			RequestID: "req-progress",
			ToolName:  "shell",
			ToolInput: "git status --short",
			Content:   "Permission requested",
		}},
	}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, agent)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitForSessionStatus(t, st, sessionID, model.SessionStatusDone)

	permissions, err := st.ListPermissions(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(permissions) != 1 || permissions[0].RequestID != "req-progress" || permissions[0].Status != "pending" {
		t.Fatalf("unexpected permissions: %#v", permissions)
	}
	messages, err := st.ListMessages(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	foundApprovalMessage := false
	for _, message := range messages {
		if strings.Contains(message.Content, "Approval ID: "+permissions[0].ID) {
			foundApprovalMessage = true
			break
		}
	}
	if !foundApprovalMessage {
		t.Fatalf("expected progress message with approval ID %q, got %#v", permissions[0].ID, messages)
	}
}

func TestRespondPermissionRejectsInactiveSession(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-inactive-run",
		SessionID: sessionID,
		RequestID: "req-inactive-run",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d: %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionReturnsNotFoundForMissingPermission(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/missing", bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionReturnsNotFoundForWrongSession(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-wrong-session",
		SessionID: sessionID,
		RequestID: "req-wrong-session",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/other-session/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionRejectsInvalidDecision(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-invalid-decision",
		SessionID: sessionID,
		RequestID: "req-invalid-decision",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"maybe"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionNormalizesDecision(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-normalized-decision",
		SessionID: sessionID,
		RequestID: "req-normalized-decision",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":" Allow "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d: %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionRejectsResolvedPermission(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-resolved",
		SessionID: sessionID,
		RequestID: "req-resolved",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "allowed",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d: %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
}

func TestRespondPermissionUpdatesPermissionAndRunner(t *testing.T) {
	runner := &fakeAgentRunner{}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-allow",
		SessionID: sessionID,
		RequestID: "req-allow",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response model.PermissionRequest
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.ID != permission.ID || response.Status != "allowed" {
		t.Fatalf("unexpected permission response: %#v", response)
	}
	if runner.permissionSessionID != sessionID || runner.permissionRequestID != permission.RequestID || !runner.permissionAllow {
		t.Fatalf("runner permission response was not called correctly: %#v", runner)
	}
	persisted, err := st.GetPermission(context.Background(), permission.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != "allowed" {
		t.Fatalf("expected persisted permission to be allowed, got %#v", persisted)
	}
}

func TestRespondPermissionDenyUpdatesPermissionAndRunner(t *testing.T) {
	runner := &fakeAgentRunner{}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-deny",
		SessionID: sessionID,
		RequestID: "req-deny",
		ToolName:  "shell",
		ToolInput: "rm -rf tmp",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"deny"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response model.PermissionRequest
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.ID != permission.ID || response.Status != "denied" {
		t.Fatalf("unexpected permission response: %#v", response)
	}
	if runner.permissionSessionID != sessionID || runner.permissionRequestID != permission.RequestID || runner.permissionAllow {
		t.Fatalf("runner permission response was not called correctly: %#v", runner)
	}
	persisted, err := st.GetPermission(context.Background(), permission.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != "denied" {
		t.Fatalf("expected persisted permission to be denied, got %#v", persisted)
	}
}

func TestRespondPermissionDoesNotUpdateWhenRunnerFails(t *testing.T) {
	runner := &fakeAgentRunner{permissionErr: errors.New("runner refused permission")}
	handler, st, cleanup := testAPIWithStoreAndAgent(t, runner)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusRunning, ""); err != nil {
		t.Fatal(err)
	}
	permission, err := st.SavePermission(context.Background(), model.PermissionRequest{
		ID:        "perm-runner-fail",
		SessionID: sessionID,
		RequestID: "req-runner-fail",
		ToolName:  "shell",
		ToolInput: "git status",
		Status:    "pending",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+sessionID+"/permissions/"+permission.ID, bytes.NewBufferString(`{"decision":"allow"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d: %s", http.StatusInternalServerError, rec.Code, rec.Body.String())
	}

	persisted, err := st.GetPermission(context.Background(), permission.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != "pending" {
		t.Fatalf("expected permission to remain pending after runner failure, got %#v", persisted)
	}
}

func TestCreateSessionStoresSelectedModel(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session","model":"gpt-5.4-mini"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID    string `json:"id"`
		Model string `json:"model"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.Model != "gpt-5.4-mini" {
		t.Fatalf("expected selected model, got %q", session.Model)
	}

	updateBody := bytes.NewBufferString(`{"model":"gpt-5.3-codex"}`)
	req = httptest.NewRequest(http.MethodPatch, "/api/sessions/"+session.ID+"/model", updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()

	if err := json.Unmarshal(body, &session); err != nil {
		t.Fatal(err)
	}
	if session.Model != "gpt-5.3-codex" {
		t.Fatalf("expected updated model, got %q", session.Model)
	}
	assertSessionRecordResponse(t, body, "update session model")
}

func TestCreateSessionReturnsSessionRecord(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "title", "status", "mode", "model", "projectSlug", "createdAt", "updatedAt"} {
		if _, ok := response[key]; !ok {
			t.Fatalf("expected create session response to include %q, got %#v", key, response)
		}
	}
	for _, key := range []string{"messages", "permissions", "plan", "changes", "project", "worktree"} {
		if _, ok := response[key]; ok {
			t.Fatalf("expected create session response to omit %q, got %#v", key, response)
		}
	}
}

func TestCreateSessionTrimsProjectSlug(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"projectSlug":"  sample-app  ","prompt":"test session"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ProjectSlug string `json:"projectSlug"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.ProjectSlug != "sample-app" {
		t.Fatalf("expected trimmed project slug, got %q", session.ProjectSlug)
	}
}

func TestCreateSessionRequiresProjectSlug(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name string
		body string
	}{
		{name: "missing project slug", body: `{"prompt":"test session"}`},
		{name: "blank project slug", body: `{"projectSlug":"  ","prompt":"test session"}`},
		{name: "unknown project slug", body: `{"projectSlug":"missing","prompt":"test session"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/sessions", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestSessionBlankModelUsesDefaultModel(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session","model":"  "}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID    string `json:"id"`
		Model string `json:"model"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.Model != "gpt-5.4" {
		t.Fatalf("expected default model, got %q", session.Model)
	}

	updateBody := bytes.NewBufferString(`{"model":"gpt-5.4-mini"}`)
	req = httptest.NewRequest(http.MethodPatch, "/api/sessions/"+session.ID+"/model", updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	updateBody = bytes.NewBufferString(`{"model":"  "}`)
	req = httptest.NewRequest(http.MethodPatch, "/api/sessions/"+session.ID+"/model", updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected default update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.Model != "gpt-5.4" {
		t.Fatalf("expected default model after blank update, got %q", session.Model)
	}
}

func TestCreateSessionTrimsInitialPrompt(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"  test session  "}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.Title != "test session" {
		t.Fatalf("expected trimmed title, got %q", session.Title)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get session status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail sessionDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Messages) != 1 || detail.Messages[0].Content != "test session" {
		t.Fatalf("expected trimmed initial message, got %#v", detail.Messages)
	}
}

func TestCreateSessionSkipsBlankInitialPrompt(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"   "}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.Title != "Work on Sample App" {
		t.Fatalf("expected default title, got %q", session.Title)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected get session status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail sessionDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Messages) != 0 {
		t.Fatalf("expected no initial messages for blank prompt, got %#v", detail.Messages)
	}
}

func TestCreateSessionTruncatesTitleByRunes(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	prompt := strings.Repeat("界", 90)
	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":` + quoteJSON(prompt) + `}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(session.Title) {
		t.Fatalf("expected valid UTF-8 title, got %q", session.Title)
	}
	if got := utf8.RuneCountInString(session.Title); got != 80 {
		t.Fatalf("expected 80 runes, got %d", got)
	}
}

func TestUpdateSessionUpdatesTitleModeAndModel(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)

	updateBody := bytes.NewBufferString(`{"title":" Updated title ","mode":"plan","model":"gpt-5.3-codex"}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID, updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()

	var session struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Mode  string `json:"mode"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		t.Fatal(err)
	}
	if session.ID != sessionID {
		t.Fatalf("expected session ID %q, got %q", sessionID, session.ID)
	}
	if session.Title != "Updated title" {
		t.Fatalf("expected trimmed title, got %q", session.Title)
	}
	if session.Mode != "plan" {
		t.Fatalf("expected plan mode, got %q", session.Mode)
	}
	if session.Model != "gpt-5.3-codex" {
		t.Fatalf("expected updated model, got %q", session.Model)
	}

	assertSessionRecordResponse(t, body, "update session")
}

func TestUpdateSessionModeReturnsSessionRecord(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)

	updateBody := bytes.NewBufferString(`{"mode":"act"}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID+"/mode", updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update mode status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()

	var session struct {
		ID   string `json:"id"`
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		t.Fatal(err)
	}
	if session.ID != sessionID {
		t.Fatalf("expected session ID %q, got %q", sessionID, session.ID)
	}
	if session.Mode != "act" {
		t.Fatalf("expected act mode, got %q", session.Mode)
	}
	assertSessionRecordResponse(t, body, "update session mode")
}

func TestUpdateSessionModeUnchangedDoesNotTouchUpdatedAt(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	before, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID+"/mode", bytes.NewBufferString(`{"mode":"ask"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update mode status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	after, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("expected unchanged mode update to keep updatedAt %s, got %s", before.UpdatedAt, after.UpdatedAt)
	}
}

func TestUpdateSessionModelUnchangedDoesNotTouchUpdatedAt(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	before, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID+"/model", bytes.NewBufferString(`{"model":" gpt-5.4 "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update model status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	after, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("expected unchanged model update to keep updatedAt %s, got %s", before.UpdatedAt, after.UpdatedAt)
	}
}

func TestUpdateSessionTruncatesTitleByRunes(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	title := strings.Repeat("界", 90)
	updateBody := bytes.NewBufferString(`{"title":` + quoteJSON(title) + `}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID, updateBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var session struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(session.Title) {
		t.Fatalf("expected valid UTF-8 title, got %q", session.Title)
	}
	if got := utf8.RuneCountInString(session.Title); got != 80 {
		t.Fatalf("expected 80 runes, got %d", got)
	}
}

func TestUpdateSessionEmptyPatchDoesNotTouchUpdatedAt(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	before, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID, bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response model.Session
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("expected response updatedAt to remain %s, got %s", before.UpdatedAt, response.UpdatedAt)
	}
	after, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("expected stored updatedAt to remain %s, got %s", before.UpdatedAt, after.UpdatedAt)
	}
}

func TestUpdateSessionUnchangedFieldsDoNotTouchUpdatedAt(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	before, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"title":"  test session  ","mode":"ask","model":"gpt-5.4"}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID, body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	after, err := st.GetSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("expected unchanged patch to keep updatedAt %s, got %s", before.UpdatedAt, after.UpdatedAt)
	}
	if after.Title != before.Title || after.Mode != before.Mode || after.Model != before.Model {
		t.Fatalf("expected unchanged patch to preserve session, before=%#v after=%#v", before, after)
	}
}

func TestUpdateSessionRejectsInvalidFields(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)

	tests := []struct {
		name string
		body string
	}{
		{name: "blank title", body: `{"title":"   "}`},
		{name: "invalid mode", body: `{"mode":"review"}`},
		{name: "invalid model", body: `{"model":"unknown-model"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sessionID, bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestUpdateSessionEndpointsReturnNotFound(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "update session", method: http.MethodPatch, path: "/api/sessions/missing", body: `{"title":"New title"}`},
		{name: "update mode", method: http.MethodPatch, path: "/api/sessions/missing/mode", body: `{"mode":"plan"}`},
		{name: "update model", method: http.MethodPatch, path: "/api/sessions/missing/model", body: `{"model":"gpt-5.4"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCreateProjectWorktreeRejectsPathTraversalName(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"../escape","branch":"feature/escape"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/sample-app/git/worktrees", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("expected no worktrees to be created, got %s", rec.Body.String())
	}
}

func TestCreateProjectWorktreeStoresManualWorktree(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"manual-worktree","branch":"feature/manual-worktree"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var worktree worktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&worktree); err != nil {
		t.Fatal(err)
	}
	if worktree.Name != "manual-worktree" || worktree.Branch != "feature/manual-worktree" {
		t.Fatalf("unexpected worktree response: %#v", worktree)
	}
}

func TestCreateProjectWorktreeExpandsHomeRoot(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	handler, _, cleanup := testAPIWithConfig(t, config.Config{WorktreeRoot: "~/broker-worktrees"})
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"manual-worktree","branch":"feature/manual-worktree"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var worktree worktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&worktree); err != nil {
		t.Fatal(err)
	}
	expectedRoot := filepath.Join(homePath, "broker-worktrees")
	expectedPath := filepath.Join(expectedRoot, "manual-worktree")
	if worktree.Path != expectedPath {
		t.Fatalf("expected expanded worktree path %q, got %q", expectedPath, worktree.Path)
	}
}

func TestCreateProjectWorktreeRejectsBlankRoot(t *testing.T) {
	handler, _, cleanup := testAPIWithConfig(t, config.Config{WorktreeRoot: "  "})
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"manual-worktree","branch":"feature/manual-worktree"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "worktree root is required") {
		t.Fatalf("expected worktree root error, got %s", rec.Body.String())
	}
}

func TestCreateProjectWorktreeReturnsNotFoundForMissingProject(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	body := bytes.NewBufferString(`{"name":"safe-worktree","branch":"feature/test"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/missing/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestCreateProjectWorktreeRequiresNameAndBranch(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	tests := []struct {
		name string
		body string
	}{
		{name: "missing name", body: `{"branch":"feature/test"}`},
		{name: "missing branch", body: `{"name":"safe-worktree"}`},
		{name: "blank values", body: `{"name":"  ","branch":"  "}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestDeleteProjectWorktreeRejectsSessionWorktree(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-active",
		SessionID:   sessionID,
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "active-worktree"),
		Branch:      "feature/active-worktree",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/projects/sample-app/git/worktrees/"+worktree.ID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d: %s", http.StatusConflict, rec.Code, rec.Body.String())
	}

	if _, err := st.GetWorktree(context.Background(), worktree.ID); err != nil {
		t.Fatalf("expected worktree to remain after rejected delete: %v", err)
	}
}

func TestListProjectWorktreesMarksSessionWorktreeActive(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-session-active",
		SessionID:   sessionID,
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "session-active-worktree"),
		Branch:      "feature/session-active-worktree",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app/git/worktrees", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var worktrees []worktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&worktrees); err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("expected session-owned and manual worktrees, got %#v", worktrees)
	}
	var found bool
	for _, candidate := range worktrees {
		if candidate.ID == worktree.ID {
			found = true
			if candidate.Status != "active" {
				t.Fatalf("expected session worktree to be active, got %#v", candidate)
			}
		}
	}
	if !found {
		t.Fatalf("expected worktree %q in response, got %#v", worktree.ID, worktrees)
	}
}

func TestListProjectWorktreesPreservesStoreOrder(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	createProject(t, handler)
	for _, worktree := range []model.Worktree{
		{
			ID:          "wt-api-order-first",
			ProjectSlug: "sample-app",
			Path:        filepath.Join(t.TempDir(), "first-worktree"),
			Branch:      "feature/first",
		},
		{
			ID:          "wt-api-order-second",
			ProjectSlug: "sample-app",
			Path:        filepath.Join(t.TempDir(), "second-worktree"),
			Branch:      "feature/second",
		},
	} {
		if _, err := st.SaveWorktree(context.Background(), worktree); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app/git/worktrees", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var worktrees []worktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&worktrees); err != nil {
		t.Fatal(err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("expected two worktrees, got %#v", worktrees)
	}
	if worktrees[0].ID != "wt-api-order-second" || worktrees[1].ID != "wt-api-order-first" {
		t.Fatalf("expected store order [wt-api-order-second wt-api-order-first], got %#v", worktrees)
	}
}

func TestGetProjectDetailWorktreesPreserveStoreOrder(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	createProject(t, handler)
	for _, worktree := range []model.Worktree{
		{
			ID:          "wt-detail-order-first",
			ProjectSlug: "sample-app",
			Path:        filepath.Join(t.TempDir(), "first-worktree"),
			Branch:      "feature/first",
		},
		{
			ID:          "wt-detail-order-second",
			ProjectSlug: "sample-app",
			Path:        filepath.Join(t.TempDir(), "second-worktree"),
			Branch:      "feature/second",
		},
	} {
		if _, err := st.SaveWorktree(context.Background(), worktree); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected detail status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Worktrees) != 2 {
		t.Fatalf("expected two worktrees, got %#v", detail.Worktrees)
	}
	if detail.Worktrees[0].ID != "wt-detail-order-second" || detail.Worktrees[1].ID != "wt-detail-order-first" {
		t.Fatalf("expected store order [wt-detail-order-second wt-detail-order-first], got %#v", detail.Worktrees)
	}
}

func TestGetProjectDetailMarksSessionWorktreeActive(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	sessionID := createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-detail-active",
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "detail-active-worktree"),
		Branch:      "feature/detail-active-worktree",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionStatus(context.Background(), sessionID, model.SessionStatusDone, worktree.ID); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/projects/sample-app", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected detail status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var detail projectDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Worktrees) != 2 {
		t.Fatalf("expected session-owned and manual worktrees, got %#v", detail.Worktrees)
	}
	var found bool
	for _, candidate := range detail.Worktrees {
		if candidate.ID == worktree.ID {
			found = true
			if candidate.Status != "active" {
				t.Fatalf("expected session worktree to be active, got %#v", candidate)
			}
		}
	}
	if !found {
		t.Fatalf("expected worktree %q in response, got %#v", worktree.ID, detail.Worktrees)
	}
}

func TestListProjectWorktreesReturnsNotFoundForMissingProject(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/projects/missing/git/worktrees", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestSwitchProjectWorktreeReturnsNotFoundForWrongProject(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	_ = createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-wrong-project",
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "wrong-project-worktree"),
		Branch:      "feature/wrong-project",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/projects/other-project/git/worktrees/"+worktree.ID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestSwitchProjectWorktreeReturnsNotFoundForMissingWorktree(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPatch, "/api/projects/sample-app/git/worktrees/missing", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestDeleteProjectWorktreeReturnsNotFoundForWrongProject(t *testing.T) {
	handler, st, cleanup := testAPIWithStore(t)
	defer cleanup()

	_ = createTestSession(t, handler)
	worktree, err := st.SaveWorktree(context.Background(), model.Worktree{
		ID:          "wt-delete-wrong-project",
		ProjectSlug: "sample-app",
		Path:        filepath.Join(t.TempDir(), "delete-wrong-project-worktree"),
		Branch:      "feature/delete-wrong-project",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/projects/other-project/git/worktrees/"+worktree.ID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	if _, err := st.GetWorktree(context.Background(), worktree.ID); err != nil {
		t.Fatalf("expected worktree to remain after rejected delete: %v", err)
	}
}

func TestDeleteProjectWorktreeReturnsNotFoundForMissingWorktree(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodDelete, "/api/projects/sample-app/git/worktrees/missing", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
}

func TestCreateProjectWorktreeRejectsBranchWithWhitespace(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"safe-worktree","branch":"feature/bad branch"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/sample-app/git/worktrees", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("expected no worktrees to be created, got %s", rec.Body.String())
	}
}

func TestCreateProjectWorktreeRejectsInvalidBranch(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	createProject(t, handler)

	body := bytes.NewBufferString(`{"name":"safe-worktree","branch":"bad..branch"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/sample-app/git/worktrees", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestCreateSessionRejectsInvalidModel(t *testing.T) {
	handler, cleanup := testAPI(t)
	defer cleanup()

	repoPath := initGitRepo(t)
	createProjectBody := bytes.NewBufferString(`{"name":"Sample App","path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", createProjectBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected project status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session","model":"unknown-model"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid model status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func assertSessionRecordResponse(t *testing.T, body []byte, action string) {
	t.Helper()

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "title", "status", "mode", "model", "projectSlug", "createdAt", "updatedAt"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("expected %s response to include %q, got %#v", action, key, raw)
		}
	}
	for _, detailOnlyField := range []string{"messages", "permissions", "plan", "changes", "project", "worktree"} {
		if _, ok := raw[detailOnlyField]; ok {
			t.Fatalf("expected %s response to omit %q, got %#v", action, detailOnlyField, raw)
		}
	}
}

func createTestSession(t *testing.T, handler http.Handler) string {
	t.Helper()

	createProject(t, handler)
	createSessionBody := bytes.NewBufferString(`{"projectSlug":"sample-app","prompt":"test session"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions", createSessionBody)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected session status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var session struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	return session.ID
}

func createProject(t *testing.T, handler http.Handler) string {
	t.Helper()

	return createNamedProject(t, handler, "Sample App")
}

func createNamedProject(t *testing.T, handler http.Handler, name string) string {
	t.Helper()

	repoPath := initGitRepo(t)
	body := bytes.NewBufferString(`{"name":` + quoteJSON(name) + `,"path":` + quoteJSON(repoPath) + `,"defaultBranch":"main"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/projects", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected project status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}
	return repoPath
}

func evalSymlinkPath(t *testing.T, path string) string {
	t.Helper()

	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func testAPI(t *testing.T) (http.Handler, func()) {
	t.Helper()
	handler, _, cleanup := testAPIWithStore(t)
	return handler, cleanup
}

func testAPIWithAllowedOrigins(t *testing.T, origins ...string) (http.Handler, func()) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "broker.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}

	handler := New(Dependencies{
		Config: config.Config{
			AllowedOrigins: origins,
		},
		Store:  st,
		Logger: slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	return handler, func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func testAPIWithStore(t *testing.T) (http.Handler, *store.Store, func()) {
	t.Helper()
	return testAPIWithStoreAndAgent(t, nil)
}

func testAPIWithStoreAndAgent(t *testing.T, runner AgentRunner) (http.Handler, *store.Store, func()) {
	t.Helper()
	return testAPIWithStoreAndAgentOptions(t, runner, slog.New(slog.NewTextHandler(os.Stderr, nil)))
}

func testAPIWithConfig(t *testing.T, cfg config.Config) (http.Handler, *store.Store, func()) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "broker.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if cfg.WorktreeRoot == "" {
		cfg.WorktreeRoot = filepath.Join(t.TempDir(), "worktrees")
	}
	handler := New(Dependencies{
		Config: cfg,
		Store:  st,
		Logger: slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	return handler, st, func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func testAPIWithStoreAndAgentOptions(t *testing.T, runner AgentRunner, logger *slog.Logger) (http.Handler, *store.Store, func()) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "broker.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}

	handler := New(Dependencies{
		Config: config.Config{
			WorktreeRoot:    filepath.Join(t.TempDir(), "worktrees"),
			GitRemote:       "origin",
			DefaultModel:    "gpt-5.4",
			AvailableModels: []string{"gpt-5.4", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"},
		},
		Store:  st,
		Agent:  runner,
		Logger: logger,
	})
	return handler, st, func() {
		if err := st.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

type fakeAgentRunner struct {
	respondStarted      chan struct{}
	releaseRespond      chan struct{}
	respondErr          error
	respondUserMessage  string
	respondProjectPath  string
	respondMessages     []model.Message
	progressEvents      []agent.ProgressEvent
	permissionSessionID string
	permissionRequestID string
	permissionAllow     bool
	permissionErr       error
	cancelSessionID     string
	cancelResult        bool
}

func (f *fakeAgentRunner) Respond(ctx context.Context, detail model.SessionDetail, userMessage string, onProgress func(agent.ProgressEvent)) (agent.RespondResult, error) {
	f.respondUserMessage = userMessage
	f.respondProjectPath = detail.Project.Path
	f.respondMessages = append([]model.Message(nil), detail.Messages...)
	if f.respondStarted != nil {
		close(f.respondStarted)
	}
	if f.respondErr != nil {
		return agent.RespondResult{}, f.respondErr
	}
	for _, event := range f.progressEvents {
		onProgress(event)
	}
	if f.releaseRespond != nil {
		select {
		case <-f.releaseRespond:
		case <-ctx.Done():
			return agent.RespondResult{}, ctx.Err()
		}
	}
	return agent.RespondResult{Content: "done"}, nil
}

func (f *fakeAgentRunner) RespondPermission(sessionID string, requestID string, allow bool) error {
	f.permissionSessionID = sessionID
	f.permissionRequestID = requestID
	f.permissionAllow = allow
	if f.permissionErr != nil {
		return f.permissionErr
	}
	return nil
}

func (f *fakeAgentRunner) CancelSession(sessionID string) bool {
	f.cancelSessionID = sessionID
	return f.cancelResult
}

func waitForSessionStatus(t *testing.T, st *store.Store, sessionID string, status model.SessionStatus) model.Session {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		session, err := st.GetSession(context.Background(), sessionID)
		if err != nil {
			t.Fatal(err)
		}
		if session.Status == status {
			return session
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected session status %q, got %#v", status, session)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func initGitRepo(t *testing.T) string {
	t.Helper()

	repoPath := t.TempDir()
	runGit(t, repoPath, "init", "-b", "main")
	runGit(t, repoPath, "config", "user.name", "Coding Broker Tests")
	runGit(t, repoPath, "config", "user.email", "coding-broker-tests@example.com")
	readmePath := filepath.Join(repoPath, "README.md")
	if err := os.WriteFile(readmePath, []byte("# test repo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repoPath, "add", "README.md")
	runGit(t, repoPath, "commit", "-m", "Initial commit")
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

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

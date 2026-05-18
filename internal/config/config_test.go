package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDefaultsAgentIdleTimeout(t *testing.T) {
	withTempWorkingDir(t)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentIdleTimeout != 10*time.Minute {
		t.Fatalf("expected default agent idle timeout 10m, got %s", cfg.AgentIdleTimeout)
	}
}

func TestLoadDefaultsHTTPAddrToAllInterfaces(t *testing.T) {
	withTempWorkingDir(t)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddr != "0.0.0.0:8787" {
		t.Fatalf("expected default HTTP addr %q, got %q", "0.0.0.0:8787", cfg.HTTPAddr)
	}
}

func TestLoadRejectsInvalidAgentIdleTimeout(t *testing.T) {
	withTempWorkingDir(t)
	t.Setenv("CODING_BROKER_AGENT_IDLE_TIMEOUT", "nope")

	if _, err := Load(); err == nil {
		t.Fatal("expected invalid timeout error")
	}
}

func TestLoadAcceptsLegacyAgentTimeout(t *testing.T) {
	withTempWorkingDir(t)
	t.Setenv("CODING_BROKER_AGENT_TIMEOUT", "30m")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentIdleTimeout != 30*time.Minute {
		t.Fatalf("expected legacy agent timeout 30m, got %s", cfg.AgentIdleTimeout)
	}
}

func TestLoadExpandsHomeDatabasePath(t *testing.T) {
	withTempWorkingDir(t)
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	t.Setenv("CODING_BROKER_DATABASE_PATH", "~/Library/coding-broker.db")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	expectedPath := filepath.Join(homePath, "Library", "coding-broker.db")
	if cfg.DatabasePath != expectedPath {
		t.Fatalf("expected expanded database path %q, got %q", expectedPath, cfg.DatabasePath)
	}
}

func TestLoadRejectsBlankDatabasePath(t *testing.T) {
	withTempWorkingDir(t)
	t.Setenv("CODING_BROKER_DATABASE_PATH", "  ")

	if _, err := Load(); err == nil {
		t.Fatal("expected blank database path error")
	}
}

func TestLoadExpandsHomeWorkspaceAndWorktreeRoots(t *testing.T) {
	withTempWorkingDir(t)
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)
	t.Setenv("CODING_BROKER_WORKSPACE_ROOT", "~/Code")
	t.Setenv("CODING_BROKER_WORKTREE_ROOT", "~/Broker/worktrees")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	expectedWorkspaceRoot := filepath.Join(homePath, "Code")
	if cfg.WorkspaceRoot != expectedWorkspaceRoot {
		t.Fatalf("expected expanded workspace root %q, got %q", expectedWorkspaceRoot, cfg.WorkspaceRoot)
	}
	expectedWorktreeRoot := filepath.Join(homePath, "Broker", "worktrees")
	if cfg.WorktreeRoot != expectedWorktreeRoot {
		t.Fatalf("expected expanded worktree root %q, got %q", expectedWorktreeRoot, cfg.WorktreeRoot)
	}
}

func TestLoadRejectsBlankWorktreeRoot(t *testing.T) {
	withTempWorkingDir(t)
	t.Setenv("CODING_BROKER_WORKTREE_ROOT", "  ")

	if _, err := Load(); err == nil {
		t.Fatal("expected blank worktree root error")
	}
}

func TestNormalizeCodexInvocationWrapsCodexScriptWithSiblingNodeWhenPathLacksNode(t *testing.T) {
	binDir := t.TempDir()
	codexPath := filepath.Join(binDir, "codex")
	nodePath := filepath.Join(binDir, "node")
	if err := os.WriteFile(codexPath, []byte("#!/usr/bin/env node\nconsole.log('codex')\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")

	command, args, err := normalizeCodexInvocation(codexPath, []string{"--dangerously-bypass-approvals-and-sandbox"})
	if err != nil {
		t.Fatal(err)
	}
	if command != nodePath {
		t.Fatalf("expected codex command %q, got %q", nodePath, command)
	}
	if len(args) != 2 {
		t.Fatalf("expected wrapped codex args, got %v", args)
	}
	if args[0] != codexPath || args[1] != "--dangerously-bypass-approvals-and-sandbox" {
		t.Fatalf("unexpected wrapped codex args: %v", args)
	}
}

func TestNormalizeCodexInvocationLeavesPlainCodexCommandUnchanged(t *testing.T) {
	command, args, err := normalizeCodexInvocation("codex", []string{"--model", "gpt-5.4"})
	if err != nil {
		t.Fatal(err)
	}
	if command != "codex" {
		t.Fatalf("expected plain codex command to remain unchanged, got %q", command)
	}
	if len(args) != 2 || args[0] != "--model" || args[1] != "gpt-5.4" {
		t.Fatalf("unexpected codex args: %v", args)
	}
}

func TestNormalizeCodexInvocationPrefersSiblingNodeForEnvNodeScripts(t *testing.T) {
	binDir := t.TempDir()
	codexPath := filepath.Join(binDir, "codex")
	nodePath := filepath.Join(binDir, "node")
	if err := os.WriteFile(codexPath, []byte("#!/usr/bin/env node\nconsole.log('codex')\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", os.Getenv("PATH"))

	command, args, err := normalizeCodexInvocation(codexPath, []string{"--model", "gpt-5.4"})
	if err != nil {
		t.Fatal(err)
	}
	if command != nodePath {
		t.Fatalf("expected sibling node %q, got %q", nodePath, command)
	}
	if len(args) != 3 || args[0] != codexPath || args[1] != "--model" || args[2] != "gpt-5.4" {
		t.Fatalf("unexpected wrapped codex args: %v", args)
	}
}

func TestNormalizeModelsIncludesDefaultFirstAndDedupes(t *testing.T) {
	models := normalizeModels([]string{"gpt-5.4-mini", "gpt-5.4", "gpt-5.4-mini", "  "}, "gpt-5.4")
	expected := []string{"gpt-5.4", "gpt-5.4-mini"}

	if len(models) != len(expected) {
		t.Fatalf("expected %v, got %v", expected, models)
	}
	for index := range expected {
		if models[index] != expected[index] {
			t.Fatalf("expected %v, got %v", expected, models)
		}
	}
}

func TestNormalizeStringListTrimsAndDedupes(t *testing.T) {
	values := normalizeStringList([]string{" http://localhost:5173 ", "", "http://localhost:5173", "http://127.0.0.1:5173"})
	expected := []string{"http://localhost:5173", "http://127.0.0.1:5173"}

	if len(values) != len(expected) {
		t.Fatalf("expected %v, got %v", expected, values)
	}
	for index := range expected {
		if values[index] != expected[index] {
			t.Fatalf("expected %v, got %v", expected, values)
		}
	}
}

func withTempWorkingDir(t *testing.T) {
	t.Helper()

	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	tmpDir := t.TempDir()
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(originalDir); err != nil {
			t.Fatal(err)
		}
	})
}

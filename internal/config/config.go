package config

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/viper"

	"github.com/slhmy/coding-broker/internal/pathutil"
)

type Config struct {
	HTTPAddr         string
	DatabasePath     string
	WorkspaceRoot    string
	WorktreeRoot     string
	CodexCommand     string
	CodexArgs        []string
	DefaultModel     string
	AvailableModels  []string
	GitRemote        string
	AllowedOrigins   []string
	LogLevel         slog.Level
	AgentIdleTimeout time.Duration
}

func Load() (Config, error) {
	v := viper.New()
	v.SetConfigName("coding-broker")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath("./config")
	v.SetEnvPrefix("CODING_BROKER")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
	v.AutomaticEnv()

	v.SetDefault("http.addr", "127.0.0.1:8787")
	v.SetDefault("database.path", "./data/coding-broker.db")
	v.SetDefault("workspace.root", ".")
	v.SetDefault("worktree.root", "./data/worktrees")
	v.SetDefault("codex.command", "codex")
	v.SetDefault("codex.args", []string{})
	v.SetDefault("codex.default_model", "gpt-5.4")
	v.SetDefault("codex.available_models", []string{"gpt-5.4", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"})
	v.SetDefault("git.remote", "origin")
	v.SetDefault("agent.idle_timeout", "10m")
	v.SetDefault("cors.allowed_origins", []string{"http://127.0.0.1:5173", "http://localhost:5173"})
	v.SetDefault("log.level", "info")

	if err := v.ReadInConfig(); err != nil {
		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return Config{}, err
		}
	}

	level, err := parseLogLevel(v.GetString("log.level"))
	if err != nil {
		return Config{}, err
	}
	agentTimeoutValue := v.GetString("agent.idle_timeout")
	if legacyTimeout := strings.TrimSpace(os.Getenv("CODING_BROKER_AGENT_TIMEOUT")); legacyTimeout != "" {
		agentTimeoutValue = legacyTimeout
	}
	agentIdleTimeout, err := time.ParseDuration(agentTimeoutValue)
	if err != nil {
		return Config{}, fmt.Errorf("invalid agent.idle_timeout: %w", err)
	}
	if agentIdleTimeout <= 0 {
		return Config{}, fmt.Errorf("agent.idle_timeout must be positive")
	}
	databasePath, err := pathutil.ExpandUser(v.GetString("database.path"))
	if err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(databasePath) == "" {
		return Config{}, fmt.Errorf("database.path is required")
	}
	workspaceRoot, err := pathutil.ExpandUser(v.GetString("workspace.root"))
	if err != nil {
		return Config{}, err
	}
	worktreeRoot, err := pathutil.ExpandUser(v.GetString("worktree.root"))
	if err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(worktreeRoot) == "" {
		return Config{}, fmt.Errorf("worktree.root is required")
	}
	codexCommand, codexArgs, err := normalizeCodexInvocation(v.GetString("codex.command"), v.GetStringSlice("codex.args"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		HTTPAddr:         v.GetString("http.addr"),
		DatabasePath:     databasePath,
		WorkspaceRoot:    workspaceRoot,
		WorktreeRoot:     worktreeRoot,
		CodexCommand:     codexCommand,
		CodexArgs:        codexArgs,
		DefaultModel:     strings.TrimSpace(v.GetString("codex.default_model")),
		AvailableModels:  normalizeModels(v.GetStringSlice("codex.available_models"), v.GetString("codex.default_model")),
		GitRemote:        v.GetString("git.remote"),
		AllowedOrigins:   normalizeStringList(v.GetStringSlice("cors.allowed_origins")),
		LogLevel:         level,
		AgentIdleTimeout: agentIdleTimeout,
	}, nil
}

func normalizeStringList(values []string) []string {
	seen := make(map[string]bool)
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	return normalized
}

func normalizeModels(models []string, defaultModel string) []string {
	seen := make(map[string]bool)
	normalized := make([]string, 0, len(models)+1)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	add(defaultModel)
	for _, model := range models {
		add(model)
	}
	return normalized
}

func normalizeCodexInvocation(command string, args []string) (string, []string, error) {
	command, err := pathutil.ExpandUser(command)
	if err != nil {
		return "", nil, err
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return "", nil, fmt.Errorf("codex.command is required")
	}
	args = append([]string(nil), args...)
	if !looksLikePath(command) {
		return command, args, nil
	}
	usesEnvNode, err := scriptUsesEnvNode(command)
	if err != nil || !usesEnvNode {
		return command, args, nil
	}
	siblingNode := filepath.Join(filepath.Dir(command), "node")
	if info, err := os.Stat(siblingNode); err == nil && !info.IsDir() {
		return siblingNode, append([]string{command}, args...), nil
	}
	if _, err := exec.LookPath("node"); err == nil {
		return command, args, nil
	}
	return command, args, nil
}

func looksLikePath(value string) bool {
	if filepath.IsAbs(value) {
		return true
	}
	return strings.ContainsRune(value, filepath.Separator)
}

func scriptUsesEnvNode(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if info.IsDir() {
		return false, nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	line, _, _ := bytes.Cut(content, []byte("\n"))
	return strings.TrimSpace(string(line)) == "#!/usr/bin/env node", nil
}

func parseLogLevel(value string) (slog.Level, error) {
	switch strings.ToLower(value) {
	case "debug":
		return slog.LevelDebug, nil
	case "info", "":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("unknown log level %q", value)
	}
}

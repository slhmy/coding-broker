package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lmittmann/tint"

	"github.com/slhmy/coding-broker/frontend"
	"github.com/slhmy/coding-broker/internal/agent"
	"github.com/slhmy/coding-broker/internal/config"
	"github.com/slhmy/coding-broker/internal/httpapi"
	"github.com/slhmy/coding-broker/internal/store"
)

var (
	version = "dev"
	commit  = ""
	date    = ""
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "coding-broker: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var showVersion bool
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Parse()

	if showVersion {
		fmt.Println(versionString())
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger := slog.New(tint.NewHandler(os.Stderr, &tint.Options{
		Level:      cfg.LogLevel,
		TimeFormat: time.Kitchen,
	}))
	slog.SetDefault(logger)

	st, err := store.Open(cfg.DatabasePath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := st.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate store: %w", err)
	}

	frontendHandler, err := frontend.Handler()
	if err != nil {
		return fmt.Errorf("load frontend: %w", err)
	}
	handler := httpapi.New(httpapi.Dependencies{
		Config:   cfg,
		Store:    st,
		Agent:    agent.NewRunner(cfg, logger),
		Logger:   logger,
		Frontend: frontendHandler,
	})
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("coding-broker listening", "addr", cfg.HTTPAddr, "database", cfg.DatabasePath)
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown server: %w", err)
		}
		logger.Info("coding-broker stopped")
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve http: %w", err)
	}
}

func versionString() string {
	value := "coding-broker " + version
	if commit != "" {
		value += " " + commit
	}
	if date != "" {
		value += " " + date
	}
	return value
}

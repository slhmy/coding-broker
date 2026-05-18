package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func New(deps Dependencies) http.Handler {
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	api := &API{
		cfg:      deps.Config,
		store:    deps.Store,
		agent:    deps.Agent,
		logger:   deps.Logger,
		frontend: deps.Frontend,
	}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(api.cors)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeErrorMessage(w, http.StatusNotFound, "not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeErrorMessage(w, http.StatusMethodNotAllowed, "method not allowed")
	})

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Route("/api", func(r chi.Router) {
		registerConfigRoutes(r, api)
		registerProjectRoutes(r, api)
		registerSessionRoutes(r, api)
	})
	if api.frontend != nil {
		r.Get("/*", api.serveFrontend)
		r.Head("/*", api.serveFrontend)
	}
	return r
}

func (api *API) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
		writeErrorMessage(w, http.StatusNotFound, "not found")
		return
	}
	api.frontend.ServeHTTP(w, r)
}

func registerConfigRoutes(r chi.Router, api *API) {
	r.Get("/config", api.getConfig)
	r.Get("/directories", api.browseDirectories)
}

func registerProjectRoutes(r chi.Router, api *API) {
	r.Get("/projects", api.listProjects)
	r.Post("/projects", api.createProject)
	r.Get("/projects/{slug}", api.getProject)
	r.Delete("/projects/{slug}", api.deleteProject)
	r.Post("/projects/{slug}/git/pull", api.pullProject)
	r.Post("/projects/{slug}/git/push", api.pushProject)
	r.Get("/projects/{slug}/git/worktrees", api.listProjectWorktrees)
	r.Post("/projects/{slug}/git/worktrees", api.createProjectWorktree)
	r.Patch("/projects/{slug}/git/worktrees/{worktreeID}", api.switchProjectWorktree)
	r.Post("/projects/{slug}/git/worktrees/{worktreeID}/pull", api.pullProjectWorktree)
	r.Post("/projects/{slug}/git/worktrees/{worktreeID}/push", api.pushProjectWorktree)
	r.Post("/projects/{slug}/git/worktrees/{worktreeID}/integrate", api.integrateProjectWorktree)
	r.Delete("/projects/{slug}/git/worktrees/{worktreeID}", api.deleteProjectWorktree)
}

func registerSessionRoutes(r chi.Router, api *API) {
	r.Get("/sessions", api.listSessions)
	r.Post("/sessions", api.createSession)
	r.Get("/sessions/{id}", api.getSession)
	r.Delete("/sessions/{id}", api.deleteSession)
	r.Patch("/sessions/{id}", api.updateSession)
	r.Patch("/sessions/{id}/mode", api.updateMode)
	r.Patch("/sessions/{id}/model", api.updateModel)
	r.Post("/sessions/{id}/read", api.markSessionRead)
	r.Post("/sessions/{id}/cancel", api.cancelSession)
	r.Post("/sessions/{id}/context/clear", api.clearSessionContext)
	r.Post("/sessions/{id}/messages", api.addMessage)
	r.Post("/sessions/{id}/permissions/{permissionID}", api.respondPermission)
	r.Get("/sessions/{id}/git/diff", api.getSessionGitDiff)
}

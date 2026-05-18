package frontend

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed dist
var distFS embed.FS

func Handler() (http.Handler, error) {
	content, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(content))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if requestPath == "" {
			requestPath = "index.html"
		}
		if _, err := fs.Stat(content, requestPath); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		if _, err := fs.Stat(content, "index.html"); err != nil {
			http.NotFound(w, r)
			return
		}
		r = r.Clone(r.Context())
		r.URL.Path = "/index.html"
		fileServer.ServeHTTP(w, r)
	}), nil
}

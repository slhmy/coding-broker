package pathutil

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func ExpandUser(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	homePath, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homePath) == "" {
		return "", fmt.Errorf("home directory is unavailable")
	}
	if path == "~" {
		return homePath, nil
	}
	return filepath.Join(homePath, strings.TrimPrefix(path, "~/")), nil
}

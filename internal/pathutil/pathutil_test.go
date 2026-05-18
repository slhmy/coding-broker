package pathutil

import (
	"path/filepath"
	"testing"
)

func TestExpandUserExpandsHomePath(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)

	expanded, err := ExpandUser("~/Code")
	if err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(homePath, "Code")
	if expanded != expected {
		t.Fatalf("expected %q, got %q", expected, expanded)
	}
}

func TestExpandUserExpandsBareHome(t *testing.T) {
	homePath := t.TempDir()
	t.Setenv("HOME", homePath)

	expanded, err := ExpandUser("~")
	if err != nil {
		t.Fatal(err)
	}
	if expanded != homePath {
		t.Fatalf("expected %q, got %q", homePath, expanded)
	}
}

func TestExpandUserLeavesOtherPathsAlone(t *testing.T) {
	for _, path := range []string{"/tmp/project", "./project", "~other/project"} {
		expanded, err := ExpandUser(path)
		if err != nil {
			t.Fatal(err)
		}
		if expanded != path {
			t.Fatalf("expected %q to remain unchanged, got %q", path, expanded)
		}
	}
}

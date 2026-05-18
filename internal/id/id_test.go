package id

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestNewIncludesPrefixAndHexSuffix(t *testing.T) {
	value := New("ses")
	if !strings.HasPrefix(value, "ses_") {
		t.Fatalf("expected ses_ prefix, got %q", value)
	}
	suffix := strings.TrimPrefix(value, "ses_")
	if len(suffix) != 16 {
		t.Fatalf("expected 16 hex characters, got %q", suffix)
	}
	for _, char := range suffix {
		if !strings.ContainsRune("0123456789abcdef", char) {
			t.Fatalf("expected lowercase hex suffix, got %q", suffix)
		}
	}
}

func TestNewWithReaderUsesProvidedRandomBytes(t *testing.T) {
	value := newWithReader("msg", strings.NewReader("\x00\x01\x02\x03\x04\x05\x06\x07"))

	if value != "msg_0001020304050607" {
		t.Fatalf("expected reader bytes in suffix, got %q", value)
	}
}

func TestNewWithReaderFallsBackWhenRandomFails(t *testing.T) {
	value := newWithReader("wt", failingReader{})

	if !strings.HasPrefix(value, "wt_") {
		t.Fatalf("expected wt_ prefix, got %q", value)
	}
	suffix := strings.TrimPrefix(value, "wt_")
	if len(suffix) != 16 {
		t.Fatalf("expected 16 hex characters, got %q", suffix)
	}
	for _, char := range suffix {
		if !strings.ContainsRune("0123456789abcdef", char) {
			t.Fatalf("expected lowercase hex suffix, got %q", suffix)
		}
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errors.New("random unavailable")
}

var _ io.Reader = failingReader{}

package id

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"io"
	"sync/atomic"
	"time"
)

var fallbackCounter atomic.Uint64

func New(prefix string) string {
	return newWithReader(prefix, rand.Reader)
}

func newWithReader(prefix string, reader io.Reader) string {
	var bytes [8]byte
	if _, err := io.ReadFull(reader, bytes[:]); err != nil {
		fallback := uint64(time.Now().UnixNano()) ^ fallbackCounter.Add(1)
		binary.BigEndian.PutUint64(bytes[:], fallback)
	}
	return prefix + "_" + hex.EncodeToString(bytes[:])
}

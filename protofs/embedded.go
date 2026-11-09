//go:build cshared

// Package main's c-shared entry points: proto can load this library and run the
// daemon in-process instead of spawning a protofs binary.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/myanvoos/proto/protofs/admin"
)

type embeddedReply struct {
	Socket   string `json:"socket,omitempty"`
	Mount    string `json:"mount,omitempty"`
	Error    string `json:"error,omitempty"`
	Embedded bool   `json:"embedded"`
}

type embeddedDaemon struct {
	mu     sync.Mutex
	state  string
	socket string
	mount  string
	stop   chan struct{}
	done   chan struct{}
	log    *os.File
	oldLog io.Writer
}

var embedded embeddedDaemon

func reply(socket, mount string, err error, owned bool) *C.char {
	r := embeddedReply{Socket: socket, Mount: mount, Embedded: owned}
	if err != nil {
		r.Error = err.Error()
	}
	data, marshalErr := json.Marshal(r)
	if marshalErr != nil {
		data = []byte(fmt.Sprintf(`{"error":%q}`, marshalErr.Error()))
	}
	return C.CString(string(data))
}

// ProtofsStart starts the daemon in-process, or returns an already-running
// daemon's socket. Empty state/mount resolve from PROTOFS_STATE/PROTOFS_MOUNT,
// ~/.proto/protofs.yml and the platform defaults, exactly like the CLI.
//
//export ProtofsStart
func ProtofsStart(cState, cMount *C.char) *C.char {
	c := &cli{state: C.GoString(cState), mount: C.GoString(cMount)}
	if err := c.resolveDirs(); err != nil {
		return reply("", "", err, false)
	}
	state, err := filepath.Abs(c.state)
	if err != nil {
		return reply("", "", fmt.Errorf("resolving state %s: %w", c.state, err), false)
	}
	mount, err := filepath.Abs(c.mount)
	if err != nil {
		return reply("", "", fmt.Errorf("resolving mount %s: %w", c.mount, err), false)
	}
	if err := os.MkdirAll(state, 0o700); err != nil {
		return reply("", "", fmt.Errorf("creating state %s: %w", state, err), false)
	}

	embedded.mu.Lock()
	defer embedded.mu.Unlock()

	// A daemon started by another process (or an earlier embedded start) is
	// reused, not owned: ProtofsStop must not stop it.
	if client, dialErr := admin.Dial(socketPath(state), adminProtocol); dialErr == nil {
		client.Close()
		return reply(socketPath(state), mount, nil, false)
	}
	if embedded.stop != nil {
		if embedded.state != state {
			return reply("", "", fmt.Errorf("an embedded protofs daemon is already running for %s", embedded.state), false)
		}
		return reply(embedded.socket, embedded.mount, nil, true)
	}

	logFile, err := os.OpenFile(logPath(state), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return reply("", "", fmt.Errorf("opening daemon log: %w", err), false)
	}
	oldLog := log.Writer()
	log.SetOutput(logFile)

	stop := make(chan struct{})
	done := make(chan struct{})
	ready := make(chan struct{})
	var serveErr error
	go func() {
		serveErr = serveInternal([]string{"-state", state, "-mount", mount}, stop, func() { close(ready) })
		if serveErr != nil {
			log.Printf("embedded protofs: %v", serveErr)
		}
		close(done)
	}()

	select {
	case <-ready:
		embedded.state, embedded.socket, embedded.mount = state, socketPath(state), mount
		embedded.stop, embedded.done = stop, done
		embedded.log, embedded.oldLog = logFile, oldLog
		return reply(embedded.socket, embedded.mount, nil, true)
	case <-done:
		log.SetOutput(oldLog)
		logFile.Close()
		if serveErr == nil {
			serveErr = fmt.Errorf("protofs daemon exited before its admin socket was ready")
		}
		return reply("", "", serveErr, false)
	case <-time.After(daemonWait):
		close(stop)
		<-done
		log.SetOutput(oldLog)
		logFile.Close()
		return reply("", "", fmt.Errorf("protofs daemon did not become ready within %s", daemonWait), false)
	}
}

// ProtofsStop stops the daemon this process started. A daemon it merely
// attached to is left running.
//
//export ProtofsStop
func ProtofsStop() {
	embedded.mu.Lock()
	defer embedded.mu.Unlock()
	if embedded.stop == nil {
		return
	}
	stop := embedded.stop
	embedded.stop = nil
	close(stop)
	select {
	case <-embedded.done:
	case <-time.After(3 * time.Second):
		log.Printf("embedded protofs: stop timed out; leaving the daemon to process exit")
	}
	log.SetOutput(embedded.oldLog)
	if embedded.log != nil {
		embedded.log.Close()
	}
	embedded.state, embedded.socket, embedded.mount = "", "", ""
	embedded.done, embedded.log, embedded.oldLog = nil, nil, nil
}

// ProtofsVersion reports the vendored daemon build.
//
//export ProtofsVersion
func ProtofsVersion() *C.char {
	return C.CString(version())
}

// ProtofsFree releases a string returned by this library.
//
//export ProtofsFree
func ProtofsFree(p *C.char) {
	C.free(unsafe.Pointer(p))
}

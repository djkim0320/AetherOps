package knowledge

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/djkim0320/AetherOps/internal/processutil"
)

const (
	defaultQueryTimeout = 5 * time.Second
	defaultResultBytes  = 4 << 20
	sidecarProtocolV1   = "aetherops-oxigraph-stdio-v1"
	oxigraphContractV1  = "0.5.9"
)

type SidecarConfig struct {
	Command    string
	Args       []string
	Dir        string
	Env        []string
	AfterStart func(*exec.Cmd) error
}

type Sidecar struct {
	mu      sync.Mutex
	command *exec.Cmd
	stdin   io.WriteCloser
	encoder *json.Encoder
	decoder *json.Decoder
	serial  atomic.Uint64
}

type sidecarRequest struct {
	ID             uint64  `json:"id"`
	Method         string  `json:"method"`
	Protocol       string  `json:"protocol,omitempty"`
	ProjectID      string  `json:"project_id,omitempty"`
	GenerationID   string  `json:"generation_id,omitempty"`
	SnapshotNQuads *string `json:"snapshot_nquads,omitempty"`
	SnapshotSHA256 string  `json:"snapshot_sha256,omitempty"`
	TripleCount    *int    `json:"triple_count,omitempty"`
	Query          string  `json:"query,omitempty"`
	MaxRows        int     `json:"max_rows,omitempty"`
	MaxBytes       int     `json:"max_bytes,omitempty"`
	TimeoutMS      int64   `json:"timeout_ms,omitempty"`
}

type sidecarResponse struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func StartSidecar(ctx context.Context, config SidecarConfig) (*Sidecar, error) {
	if strings.TrimSpace(config.Command) == "" {
		return nil, errors.New("Oxigraph sidecar command is required")
	}
	isolatedEnvironment, err := IsolatedSidecarEnvironment(config.Env)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, config.Command, config.Args...)
	command.Dir = config.Dir
	command.Env = isolatedEnvironment
	processutil.ConfigureNoWindow(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if config.AfterStart != nil {
		if err := config.AfterStart(command); err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			return nil, err
		}
	}
	sidecar := &Sidecar{command: command, stdin: stdin, encoder: json.NewEncoder(stdin), decoder: json.NewDecoder(bufio.NewReaderSize(stdout, 64<<10))}
	handshakeCtx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()
	raw, err := sidecar.exchange(handshakeCtx, sidecarRequest{Method: "hello", Protocol: sidecarProtocolV1})
	if err != nil {
		_ = sidecar.Close()
		return nil, fmt.Errorf("negotiate Oxigraph sidecar protocol: %w", err)
	}
	var handshake struct {
		Protocol        string `json:"protocol"`
		OxigraphVersion string `json:"oxigraph_version"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&handshake); err != nil || handshake.Protocol != sidecarProtocolV1 || handshake.OxigraphVersion != oxigraphContractV1 {
		_ = sidecar.Close()
		if err != nil {
			return nil, fmt.Errorf("decode Oxigraph sidecar handshake: %w", err)
		}
		return nil, fmt.Errorf("Oxigraph sidecar contract mismatch: protocol=%q version=%q", handshake.Protocol, handshake.OxigraphVersion)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		_ = sidecar.Close()
		return nil, errors.New("Oxigraph sidecar handshake contains trailing JSON")
	}
	return sidecar, nil
}

func (sidecar *Sidecar) LoadSnapshot(ctx context.Context, projectID, generationID string, snapshot []byte, expectedHash string, tripleCount int) error {
	if projectID == "" || generationID == "" || tripleCount < 0 {
		return errors.New("invalid RDF snapshot contract")
	}
	sum := sha256.Sum256(snapshot)
	actualHash := hex.EncodeToString(sum[:])
	if !strings.EqualFold(actualHash, expectedHash) {
		return errors.New("RDF snapshot checksum mismatch")
	}
	actualTriples := 0
	for _, line := range strings.Split(string(snapshot), "\n") {
		if strings.TrimSpace(line) != "" {
			actualTriples++
		}
	}
	if actualTriples != tripleCount {
		return fmt.Errorf("RDF snapshot triple count mismatch: got %d want %d", actualTriples, tripleCount)
	}
	snapshotText := string(snapshot)
	_, err := sidecar.exchange(ctx, sidecarRequest{Method: "load", ProjectID: projectID, GenerationID: generationID, SnapshotNQuads: &snapshotText, SnapshotSHA256: actualHash, TripleCount: &tripleCount})
	return err
}

func (sidecar *Sidecar) Query(ctx context.Context, projectID, generationID, query string, maxRows int) (json.RawMessage, error) {
	if err := ValidateReadOnlySPARQL(query); err != nil {
		return nil, err
	}
	if projectID == "" || generationID == "" {
		return nil, errors.New("project and active generation are required")
	}
	if maxRows <= 0 || maxRows > 1000 {
		return nil, errors.New("SPARQL max rows must be between 1 and 1000")
	}
	queryCtx, cancel := context.WithTimeout(ctx, defaultQueryTimeout)
	defer cancel()
	return sidecar.exchange(queryCtx, sidecarRequest{Method: "query", ProjectID: projectID, GenerationID: generationID, Query: query, MaxRows: maxRows, MaxBytes: defaultResultBytes, TimeoutMS: defaultQueryTimeout.Milliseconds()})
}

func (sidecar *Sidecar) exchange(ctx context.Context, request sidecarRequest) (json.RawMessage, error) {
	sidecar.mu.Lock()
	defer sidecar.mu.Unlock()
	if sidecar.command == nil || sidecar.command.Process == nil {
		return nil, errors.New("Oxigraph sidecar is not running")
	}
	request.ID = sidecar.serial.Add(1)
	type outcome struct {
		response sidecarResponse
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		if err := sidecar.encoder.Encode(request); err != nil {
			done <- outcome{err: err}
			return
		}
		var response sidecarResponse
		if err := sidecar.decoder.Decode(&response); err != nil {
			done <- outcome{err: err}
			return
		}
		done <- outcome{response: response}
	}()
	select {
	case <-ctx.Done():
		sidecar.invalidateLocked()
		return nil, ctx.Err()
	case result := <-done:
		if result.err != nil {
			sidecar.invalidateLocked()
			return nil, result.err
		}
		if result.response.ID != request.ID {
			sidecar.invalidateLocked()
			return nil, errors.New("Oxigraph sidecar response id mismatch")
		}
		if !result.response.OK {
			if result.response.Error == "" {
				result.response.Error = "Oxigraph sidecar rejected request"
			}
			return nil, errors.New(result.response.Error)
		}
		if len(result.response.Result) == 0 || !json.Valid(result.response.Result) {
			sidecar.invalidateLocked()
			return nil, errors.New("Oxigraph sidecar returned an invalid complete result")
		}
		if request.MaxBytes > 0 && len(result.response.Result) > request.MaxBytes {
			sidecar.invalidateLocked()
			return nil, errors.New("Oxigraph sidecar result exceeded the requested byte limit")
		}
		return result.response.Result, nil
	}
}

// invalidateLocked makes a timed-out, crashed, malformed, or desynchronized
// sidecar permanently unusable. Reusing its JSONL stream could associate a
// later request with stale output, so callers must start a fresh process.
func (sidecar *Sidecar) invalidateLocked() {
	if sidecar.command == nil {
		return
	}
	if sidecar.command.Process != nil {
		_ = sidecar.command.Process.Kill()
	}
	_ = sidecar.command.Wait()
	sidecar.command = nil
}

func (sidecar *Sidecar) Close() error {
	sidecar.mu.Lock()
	defer sidecar.mu.Unlock()
	if sidecar.command == nil {
		return nil
	}
	_ = sidecar.stdin.Close()
	err := sidecar.command.Wait()
	sidecar.command = nil
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "killed") {
		return err
	}
	return nil
}

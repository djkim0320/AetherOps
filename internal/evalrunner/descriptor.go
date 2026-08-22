package evalrunner

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/evalgate"
)

const SessionDescriptorSchemaV2 = "aetherops_release_eval_api_session_v2"

type SessionDescriptor struct {
	Schema        string                       `json:"schema"`
	Endpoint      string                       `json:"endpoint"`
	TokenFile     string                       `json:"token_file"`
	PID           int                          `json:"pid"`
	ProductBuild  evalgate.ProductBuildBinding `json:"product_build"`
	StartedAt     time.Time                    `json:"started_at"`
	Mode          string                       `json:"mode"`
	BuildMode     string                       `json:"build_mode"`
	RuntimeReady  bool                         `json:"runtime_set_ready"`
	CodexReady    bool                         `json:"codex_initialize_model_list_ready"`
	OxigraphReady bool                         `json:"oxigraph_handshake_ready"`
	APIReady      bool                         `json:"api_ready"`
}

func LoadSessionDescriptor(path string, build evalgate.ProductBuildBinding) (SessionDescriptor, []byte, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return SessionDescriptor{}, nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 0 || info.Size() > 64*1024 {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor is not a small regular non-symlink file")
	}
	raw, err := os.ReadFile(absolute)
	if err != nil || int64(len(raw)) != info.Size() {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor changed while reading")
	}
	var descriptor SessionDescriptor
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&descriptor); err != nil {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor JSON is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor contains trailing JSON data")
	}
	if descriptor.Schema != SessionDescriptorSchemaV2 || descriptor.PID <= 0 || descriptor.StartedAt.IsZero() ||
		descriptor.ProductBuild != build || descriptor.Mode != "normal" ||
		(descriptor.BuildMode != "release" && descriptor.BuildMode != "development") ||
		!descriptor.RuntimeReady || !descriptor.CodexReady || !descriptor.OxigraphReady || !descriptor.APIReady {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor identity is invalid")
	}
	if err := validateDescriptorProcess(descriptor.PID, build.ExecutableSHA256); err != nil {
		return SessionDescriptor{}, nil, err
	}
	endpoint, err := normalizeEndpoint(descriptor.Endpoint)
	if err != nil || endpoint != descriptor.Endpoint {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor endpoint is invalid")
	}
	expectedTokenName := filepath.Base(absolute) + ".token"
	if descriptor.TokenFile != expectedTokenName || filepath.Base(descriptor.TokenFile) != descriptor.TokenFile {
		return SessionDescriptor{}, nil, errors.New("release evaluation session descriptor token path is invalid")
	}
	token, err := ReadTokenFile(filepath.Join(filepath.Dir(absolute), descriptor.TokenFile))
	if err != nil {
		return SessionDescriptor{}, nil, err
	}
	return descriptor, token, nil
}

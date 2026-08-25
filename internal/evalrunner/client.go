package evalrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/evalgate"
)

const maxAPIResponseBytes = 2 << 20

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

type apiClient struct {
	endpoint string
	token    string
	http     *http.Client
}

type definitiveAPIError struct {
	operation string
	status    int
}

func (err definitiveAPIError) Error() string {
	return fmt.Sprintf("AetherOps API %s failed with HTTP %d", err.operation, err.status)
}

func ReadTokenFile(path string) ([]byte, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, errors.New("read API token file: file is unavailable")
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
		return nil, errors.New("read API token file: expected a small regular non-symlink file")
	}
	raw, err := os.ReadFile(absolute)
	if err != nil {
		return nil, errors.New("read API token file: access failed")
	}
	token := strings.TrimSpace(string(raw))
	for index := range raw {
		raw[index] = 0
	}
	if !tokenPattern.MatchString(token) {
		return nil, errors.New("read API token file: token format is invalid")
	}
	return []byte(token), nil
}

func ZeroToken(token []byte) {
	for index := range token {
		token[index] = 0
	}
}

func normalizeEndpoint(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("endpoint must be an origin-only HTTP IPv4 loopback URL")
	}
	host, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil || host != "127.0.0.1" {
		return "", errors.New("endpoint must use the literal IPv4 loopback address and an explicit port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("endpoint port is invalid")
	}
	return "http://127.0.0.1:" + strconv.Itoa(port), nil
}

func newAPIClient(config Config, endpoint string) (*apiClient, error) {
	token := strings.TrimSpace(string(config.Token))
	if !tokenPattern.MatchString(token) {
		return nil, errors.New("API token format is invalid")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &apiClient{endpoint: endpoint, token: token, http: client}, nil
}

func (client *apiClient) request(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, client.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Origin", client.endpoint)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return client.http.Do(request)
}

func (client *apiClient) preflight(ctx context.Context, expectedBuild evalgate.ProductBuildBinding) error {
	response, err := client.request(ctx, http.MethodGet, "/api/v1/status", nil)
	if err != nil {
		return errors.New("authenticated loopback API preflight could not connect")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return definitiveAPIError{operation: "preflight", status: response.StatusCode}
	}
	var status struct {
		Ready                   bool                         `json:"ready"`
		Version                 string                       `json:"version"`
		Platform                string                       `json:"platform"`
		ProductBuild            evalgate.ProductBuildBinding `json:"product_build"`
		ModelOptions            json.RawMessage              `json:"model_options"`
		DefaultRunConfiguration json.RawMessage              `json:"default_run_configuration"`
		RuntimeUpdate           json.RawMessage              `json:"runtime_update,omitempty"`
		RuntimeWarnings         json.RawMessage              `json:"runtime_warnings,omitempty"`
		Warnings                json.RawMessage              `json:"warnings,omitempty"`
		Browser                 json.RawMessage              `json:"browser,omitempty"`
	}
	if err := decodeBounded(response.Body, &status); err != nil {
		return errors.New("authenticated loopback API preflight response is invalid")
	}
	if !status.Ready || status.ProductBuild != expectedBuild {
		return errors.New("authenticated loopback API belongs to a different or unready product build")
	}
	return nil
}

type startRequest struct {
	Query           string `json:"query"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	Speed           string `json:"speed"`
}

func (client *apiClient) startRun(ctx context.Context, target Target, prompt string) (core.Run, bool, error) {
	payload, err := json.Marshal(startRequest{
		Query: prompt, Model: core.PlannerModel, ReasoningEffort: core.PlannerEffort, Speed: "standard",
	})
	if err != nil {
		return core.Run{}, false, err
	}
	path := "/api/v1/projects/" + url.PathEscape(strings.TrimSpace(target.ProjectID)) + "/runs"
	if target.SessionID != "" {
		path = "/api/v1/sessions/" + url.PathEscape(strings.TrimSpace(target.SessionID)) + "/runs"
	}
	response, err := client.request(ctx, http.MethodPost, path, payload)
	if err != nil {
		return core.Run{}, true, errors.New("run submission transport outcome is ambiguous")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		_ = discardBounded(response.Body)
		return core.Run{}, false, definitiveAPIError{operation: "run submission", status: response.StatusCode}
	}
	var run core.Run
	if err := decodeBounded(response.Body, &run); err != nil {
		return core.Run{}, true, errors.New("accepted run response did not expose a trustworthy run id")
	}
	if !safeIDPattern.MatchString(run.ID) {
		return core.Run{}, true, errors.New("accepted run response did not expose a trustworthy run id")
	}
	return run, false, nil
}

func (client *apiClient) run(ctx context.Context, runID string) (core.Run, error) {
	response, err := client.request(ctx, http.MethodGet, "/api/v1/runs/"+url.PathEscape(runID), nil)
	if err != nil {
		return core.Run{}, errors.New("run status readback could not connect")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_ = discardBounded(response.Body)
		return core.Run{}, definitiveAPIError{operation: "run status readback", status: response.StatusCode}
	}
	var run core.Run
	if err := decodeBounded(response.Body, &run); err != nil {
		return core.Run{}, errors.New("run status readback response is invalid")
	}
	return run, nil
}

func (client *apiClient) approvals(ctx context.Context, runID string) ([]ApprovalObservation, error) {
	response, err := client.request(ctx, http.MethodGet, "/api/v1/approvals", nil)
	if err != nil {
		return nil, errors.New("pending approval readback could not connect")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_ = discardBounded(response.Body)
		return nil, definitiveAPIError{operation: "pending approval readback", status: response.StatusCode}
	}
	var approvals []core.Approval
	if err := decodeBounded(response.Body, &approvals); err != nil {
		return nil, errors.New("pending approval readback response is invalid")
	}
	result := make([]ApprovalObservation, 0)
	for _, approval := range approvals {
		if approval.RunID != runID || approval.Status != "pending" {
			continue
		}
		result = append(result, ApprovalObservation{
			ID: approval.ID, Kind: approval.Kind, Summary: approval.Summary,
			Server: approval.Server, Tool: approval.Tool, Risk: approval.Risk,
			ExternalSideEffect: approval.ExternalSideEffect, Status: approval.Status,
		})
	}
	return result, nil
}

func decodeBounded(reader io.Reader, target any) error {
	limited := &io.LimitedReader{R: reader, N: maxAPIResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("response contains trailing JSON data")
	}
	if limited.N <= 0 {
		return errors.New("response exceeds size limit")
	}
	return nil
}

func discardBounded(reader io.Reader) error {
	written, err := io.Copy(io.Discard, io.LimitReader(reader, maxAPIResponseBytes+1))
	if err != nil {
		return err
	}
	if written > maxAPIResponseBytes {
		return errors.New("response exceeds size limit")
	}
	return nil
}

package mcpserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/browser"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/engineering"
	"github.com/djkim0320/Aether-claw/internal/knowledge"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/toolstudio"
)

const (
	protocolVersion               = "2025-06-18"
	maxMessageBytes               = 32 << 20
	maxArtifactBytes              = 16 << 20
	maxEvidenceBytes              = 80 << 20
	maxEngineeringSolverTextBytes = 16 << 10
)

type Embedder interface {
	Embed(context.Context, []string) ([][]float32, error)
}

type KnowledgeReader interface {
	SPARQLGeneration(context.Context, string, string, string, int) (any, error)
	EntityGeneration(context.Context, string, string, string) (any, error)
	AssertionGeneration(context.Context, string, string, string) (any, error)
}

type Server struct {
	DB          *store.DB
	CAS         *cas.Store
	Embedder    Embedder
	Knowledge   KnowledgeReader
	Engineering *engineering.Service
	ToolStudio  interface {
		ProposeForStage(context.Context, string, string, toolstudio.Proposal) (core.ToolPackage, error)
	}
	evidencePolicy   browser.Policy
	scholarEndpoints scholarlyEndpoints
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type capabilityArgs struct {
	RunID          string `json:"run_id"`
	StageAttemptID string `json:"stage_attempt_id"`
}

func (server *Server) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	if server.DB == nil || server.CAS == nil {
		return errors.New("MCP server storage is not configured")
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64<<10), maxMessageBytes)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var incoming request
		if err := json.Unmarshal(line, &incoming); err != nil {
			if err := encoder.Encode(response{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "invalid JSON"}}); err != nil {
				return err
			}
			continue
		}
		result, rpcErr := server.handle(ctx, incoming)
		if len(incoming.ID) == 0 {
			continue
		}
		if err := encoder.Encode(response{JSONRPC: "2.0", ID: incoming.ID, Result: result, Error: rpcErr}); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func (server *Server) handle(ctx context.Context, incoming request) (any, *rpcError) {
	if incoming.JSONRPC != "2.0" {
		return nil, &rpcError{Code: -32600, Message: "jsonrpc must be 2.0"}
	}
	switch incoming.Method {
	case "initialize":
		name := "aetherops-internal"
		if server.Engineering != nil {
			name = "aetherops-engineering"
		}
		return map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": name, "version": "0.1.0-alpha.1"},
		}, nil
	case "notifications/initialized", "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": server.toolDefinitions()}, nil
	case "tools/call":
		var params callParams
		if err := json.Unmarshal(incoming.Params, &params); err != nil || params.Name == "" {
			return nil, &rpcError{Code: -32602, Message: "invalid tool call parameters"}
		}
		result, err := server.call(ctx, params.Name, params.Arguments)
		if err != nil {
			return toolError(err), nil
		}
		return toolResultFor(params.Name, result), nil
	default:
		return nil, &rpcError{Code: -32601, Message: "method not found"}
	}
}

func (server *Server) toolDefinitions() []map[string]any {
	capabilityProperties := map[string]any{
		"run_id":           map[string]any{"type": "string", "minLength": 1},
		"stage_attempt_id": map[string]any{"type": "string", "minLength": 1},
	}
	definition := func(name, description string, extra map[string]any, required ...string) map[string]any {
		properties := make(map[string]any, len(capabilityProperties)+len(extra))
		for key, value := range capabilityProperties {
			properties[key] = value
		}
		for key, value := range extra {
			properties[key] = value
		}
		allRequired := append([]string{"run_id", "stage_attempt_id"}, required...)
		return map[string]any{
			"name": name, "description": description,
			"annotations": toolAnnotations(name),
			"inputSchema": map[string]any{
				"type": "object", "properties": properties,
				"required": allRequired, "additionalProperties": false,
			},
		}
	}
	if server.Engineering != nil {
		return engineeringToolDefinitions(definition)
	}
	evidenceCapture := definition("evidence_capture", "Fetch one public HTTP(S) source directly through AetherOps' SSRF-safe network boundary and commit the exact HTTP 200 response bytes (up to 80 MiB) to run evidence. Caller-supplied content and shell download output are rejected. The result source_url is the final canonical URL after validated redirects.", map[string]any{
		"source_url": map[string]any{"type": "string", "minLength": 1},
		"title":      map[string]any{"type": "string", "minLength": 1},
		"publisher":  map[string]any{"type": "string"},
	}, "source_url", "title")
	scholarlySearch := definition("scholarly_search", "Search Crossref, arXiv, and Europe PMC concurrently for scholarly candidates. Results are discovery metadata only, never evidence: open a returned url or full_text_url and capture the actual public source with evidence_capture before citing it.", map[string]any{
		"query": map[string]any{"type": "string", "minLength": 1, "maxLength": maxScholarlyQueryBytes},
		"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": maxScholarlyLimit, "default": defaultScholarlyLimit},
	}, "query")
	return []map[string]any{
		definition("memory_search", "Search adopted AetherOps project memory.", map[string]any{
			"query": map[string]any{"type": "string", "minLength": 1},
		}, "query"),
		definition("memory_get", "Read one adopted memory chunk.", map[string]any{
			"chunk_id": map[string]any{"type": "string", "minLength": 1},
		}, "chunk_id"),
		definition("knowledge_sparql", "Run a project-scoped, local, read-only SPARQL 1.1 query. Report claims still require knowledge_get or memory_get evidence readback.", map[string]any{
			"query":    map[string]any{"type": "string", "minLength": 1, "maxLength": 65536},
			"max_rows": map[string]any{"type": "integer", "minimum": 1, "maximum": 1000, "default": 250},
		}, "query"),
		definition("knowledge_get", "Read one graph entity or assertion with qualifiers, proof chain, and exact evidence handles.", map[string]any{
			"kind": map[string]any{"type": "string", "enum": []string{"entity", "assertion"}},
			"id":   map[string]any{"type": "string", "minLength": 1},
		}, "kind", "id"),
		definition("tool_package_propose", "Propose a project-scoped skill or declarative HTTPS JSON internal MCP adapter when the current task needs a reusable tool. This creates an immutable pending proposal only. After user review and activation in Tool Studio, both kinds appear in tool_catalog immediately; read Skill files with tool_get and invoke MCP adapters with tool_run.", map[string]any{
			"kind":         map[string]any{"type": "string", "enum": []string{"skill", "mcp"}},
			"name":         map[string]any{"type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$"},
			"display_name": map[string]any{"type": "string", "minLength": 1, "maxLength": 80},
			"description":  map[string]any{"type": "string", "minLength": 1, "maxLength": 500},
			"version":      map[string]any{"type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$"},
			"files":        map[string]any{"type": "array", "minItems": 1, "maxItems": 32, "items": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string", "minLength": 1}, "content": map[string]any{"type": "string", "minLength": 1}}, "required": []string{"path", "content"}, "additionalProperties": false}},
		}, "kind", "name", "display_name", "description", "version", "files"),
		definition("tool_catalog", "List user-approved Skills and declarative MCP tools available to this project, including package ids, hashes, and MCP input schemas.", nil),
		definition("tool_get", "Read the exact hash-verified files of one user-approved project Skill returned by tool_catalog.", map[string]any{
			"package_id": map[string]any{"type": "string", "pattern": "^tool_[a-f0-9]{32}$"},
		}, "package_id"),
		definition("tool_run", "Run one user-approved project tool from tool_catalog through AetherOps' internal SSRF-safe HTTPS JSON boundary. The network action requires user approval and returned JSON is discovery output until evidence_capture reads back the source_url.", map[string]any{
			"package_id": map[string]any{"type": "string", "pattern": "^tool_[a-f0-9]{32}$"},
			"tool":       map[string]any{"type": "string", "minLength": 1},
			"input":      map[string]any{"type": "object", "additionalProperties": true},
		}, "package_id", "tool", "input"),
		scholarlySearch,
		evidenceCapture,
		definition("artifact_publish_plan", "Publish the validated research plan.", artifactProperties(), "content"),
		definition("artifact_publish_evidence", "Publish a validated evidence bundle.", artifactProperties(), "content"),
		definition("artifact_publish_report", "Publish a validated report manifest.", artifactProperties(), "content"),
		definition("artifact_publish_review", "Publish a validated review verdict.", artifactProperties(), "content"),
	}
}

func toolAnnotations(name string) map[string]any {
	type annotationSet struct {
		readOnly, destructive, idempotent, openWorld bool
	}
	var annotations annotationSet
	switch name {
	case "memory_search":
		// Search is logically read-only, but embedding the query talks to the
		// configured OpenAI service and can consume metered capacity. Do not
		// promise closed-world or repeat-without-additional-effect semantics.
		annotations = annotationSet{readOnly: true, openWorld: true}
	case "scholarly_search":
		// Provider metadata is fetched from the public internet but no local or
		// provider state is written. The candidate source must be captured by a
		// separate evidence_capture call before it can support a claim.
		annotations = annotationSet{readOnly: true, openWorld: true}
	case "memory_get", "knowledge_sparql", "knowledge_get", "tool_catalog", "tool_get":
		annotations = annotationSet{readOnly: true, idempotent: true}
	case "tool_run":
		annotations = annotationSet{readOnly: true, openWorld: true}
	case "evidence_capture", "tool_package_propose",
		"artifact_publish_plan", "artifact_publish_evidence",
		"artifact_publish_report", "artifact_publish_review":
		// These calls append run-scoped CAS/SQLite state. They do not delete or
		// overwrite existing state, but repeating a call creates another record.
		annotations = annotationSet{}
	case "engineering_capabilities", "engineering_get":
		annotations = annotationSet{readOnly: true, idempotent: true}
	case "openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012":
		// Solver jobs add artifacts without mutating their inputs. The store's
		// stage-local (operation, normalized spec) key enforces at-most-once
		// execution; a successful duplicate is read back and every other prior
		// state is fail-closed rather than re-executed.
		annotations = annotationSet{idempotent: true}
	default:
		panic("MCP tool annotations are not classified: " + name)
	}
	return map[string]any{
		"readOnlyHint":    annotations.readOnly,
		"destructiveHint": annotations.destructive,
		"idempotentHint":  annotations.idempotent,
		"openWorldHint":   annotations.openWorld,
	}
}

func artifactProperties() map[string]any {
	return map[string]any{
		"content":    map[string]any{"type": "string", "minLength": 1},
		"media_type": map[string]any{"type": "string", "default": "application/json"},
	}
}

func (server *Server) call(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	var capability capabilityArgs
	if err := json.Unmarshal(raw, &capability); err != nil {
		return nil, errors.New("invalid tool arguments")
	}
	if capability.RunID == "" || capability.StageAttemptID == "" {
		return nil, errors.New("run_id and stage_attempt_id are required")
	}
	attempt, err := server.DB.StageAttempt(ctx, capability.RunID, capability.StageAttemptID)
	if err != nil {
		return nil, err
	}
	if attempt.Stage == core.StageCollect && attempt.Ordinal == core.EngineeringVerificationOrdinal {
		if server.Engineering == nil {
			return nil, errors.New("the engineering verification attempt cannot call internal memory, evidence, graph, or artifact tools")
		}
		if name != "engineering_get" && name != "xfoil_polar" {
			return nil, errors.New("the engineering verification attempt permits only engineering_get and xfoil_polar")
		}
	}
	if server.Engineering != nil {
		return server.callEngineering(ctx, name, raw, capability)
	}
	projectID, err := server.DB.ValidateStageCapability(ctx, capability.RunID, capability.StageAttemptID)
	if err != nil {
		return nil, err
	}
	generationID, err := server.DB.KnowledgeGenerationForRun(ctx, capability.RunID)
	if err != nil {
		return nil, err
	}
	if name == "memory_search" || name == "knowledge_sparql" || name == "knowledge_get" {
		if err := server.DB.VerifyKnowledgeSnapshot(ctx, projectID, generationID, server.CAS); err != nil {
			markErr := server.DB.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), projectID, generationID, err)
			if markErr != nil {
				err = errors.Join(err, fmt.Errorf("mark corrupt knowledge head failed: %w", markErr))
			}
			return nil, fmt.Errorf("run-pinned knowledge generation is unavailable: %w", err)
		}
	}
	switch name {
	case "tool_package_propose":
		if server.ToolStudio == nil {
			return nil, errors.New("tool studio is unavailable")
		}
		var arguments struct {
			capabilityArgs
			Kind        string                    `json:"kind"`
			Name        string                    `json:"name"`
			DisplayName string                    `json:"display_name"`
			Description string                    `json:"description"`
			Version     string                    `json:"version"`
			Files       []toolstudio.ProposalFile `json:"files"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil {
			return nil, errors.New("invalid tool package proposal")
		}
		return server.ToolStudio.ProposeForStage(ctx, capability.RunID, capability.StageAttemptID, toolstudio.Proposal{Kind: arguments.Kind, Name: arguments.Name, DisplayName: arguments.DisplayName, Description: arguments.Description, Version: arguments.Version, Files: arguments.Files})
	case "tool_catalog":
		return managedToolCatalog(ctx, server.DB, projectID)
	case "tool_get":
		var arguments struct {
			capabilityArgs
			PackageID string `json:"package_id"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil || arguments.PackageID == "" {
			return nil, errors.New("package_id is required")
		}
		return getManagedSkill(ctx, server.DB, projectID, arguments.PackageID)
	case "tool_run":
		var arguments struct {
			capabilityArgs
			PackageID string         `json:"package_id"`
			Tool      string         `json:"tool"`
			Input     map[string]any `json:"input"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil || arguments.PackageID == "" || arguments.Tool == "" || arguments.Input == nil {
			return nil, errors.New("package_id, tool, and input are required")
		}
		if _, exists := arguments.Input["run_id"]; exists {
			return nil, errors.New("managed tool input must not override run_id")
		}
		if _, exists := arguments.Input["stage_attempt_id"]; exists {
			return nil, errors.New("managed tool input must not override stage_attempt_id")
		}
		arguments.Input["run_id"] = capability.RunID
		arguments.Input["stage_attempt_id"] = capability.StageAttemptID
		encoded, err := json.Marshal(arguments.Input)
		if err != nil {
			return nil, errors.New("managed tool input is invalid")
		}
		return executeManagedTool(ctx, server.DB, server.evidencePolicy, arguments.PackageID, arguments.Tool, encoded)
	case "memory_search":
		if server.Embedder == nil {
			return nil, errors.New("OpenAI embeddings are not configured")
		}
		activeIndex, err := server.DB.ActiveEmbeddingIndex(ctx, projectID)
		if err != nil {
			return nil, err
		}
		if activeIndex.Model != rag.EmbeddingModel || activeIndex.Dimensions != rag.EmbeddingDimensions {
			return nil, errors.New("active memory index is incompatible with the configured embeddings client")
		}
		var arguments struct {
			capabilityArgs
			Query string `json:"query"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil || strings.TrimSpace(arguments.Query) == "" {
			return nil, errors.New("query is required")
		}
		vectors, err := server.Embedder.Embed(ctx, []string{arguments.Query})
		if err != nil {
			return nil, err
		}
		if len(vectors) != 1 {
			return nil, errors.New("embeddings response count mismatch")
		}
		return server.DB.SearchMemoryWithGraphGeneration(ctx, projectID, generationID, arguments.Query, vectors[0], 12)
	case "memory_get":
		var arguments struct {
			capabilityArgs
			ChunkID string `json:"chunk_id"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil || arguments.ChunkID == "" {
			return nil, errors.New("chunk_id is required")
		}
		return server.DB.MemoryGet(ctx, projectID, arguments.ChunkID)
	case "knowledge_sparql":
		if server.Knowledge == nil {
			return nil, errors.New("knowledge graph is not configured")
		}
		var arguments struct {
			capabilityArgs
			Query   string `json:"query"`
			MaxRows int    `json:"max_rows"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil || strings.TrimSpace(arguments.Query) == "" || len(arguments.Query) > knowledge.MaxSPARQLQueryBytes {
			return nil, errors.New("a SPARQL query up to 64 KiB is required")
		}
		if err := knowledge.ValidateReadOnlySPARQL(arguments.Query); err != nil {
			return nil, err
		}
		if arguments.MaxRows <= 0 {
			arguments.MaxRows = 250
		}
		if arguments.MaxRows > 1000 {
			return nil, errors.New("max_rows must not exceed 1000")
		}
		return server.Knowledge.SPARQLGeneration(ctx, projectID, generationID, arguments.Query, arguments.MaxRows)
	case "knowledge_get":
		if server.Knowledge == nil {
			return nil, errors.New("knowledge graph is not configured")
		}
		var arguments struct {
			capabilityArgs
			Kind string `json:"kind"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil || strings.TrimSpace(arguments.ID) == "" {
			return nil, errors.New("knowledge kind and id are required")
		}
		switch arguments.Kind {
		case "entity":
			return server.Knowledge.EntityGeneration(ctx, projectID, generationID, arguments.ID)
		case "assertion":
			return server.Knowledge.AssertionGeneration(ctx, projectID, generationID, arguments.ID)
		default:
			return nil, errors.New("knowledge kind must be entity or assertion")
		}
	case "scholarly_search":
		var arguments struct {
			capabilityArgs
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil {
			return nil, errors.New("invalid scholarly search arguments")
		}
		return searchScholarly(ctx, server.evidencePolicy, server.scholarEndpoints, arguments.Query, arguments.Limit)
	case "evidence_capture":
		var arguments struct {
			capabilityArgs
			SourceURL string `json:"source_url"`
			Title     string `json:"title"`
			Publisher string `json:"publisher"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil {
			return nil, errors.New("invalid evidence arguments")
		}
		if strings.TrimSpace(arguments.SourceURL) == "" || strings.TrimSpace(arguments.Title) == "" {
			return nil, errors.New("evidence source URL and title are required")
		}
		fetched, err := fetchPublicEvidence(ctx, server.evidencePolicy, arguments.SourceURL)
		if err != nil {
			return nil, err
		}
		receipt, err := server.CAS.PutBytes(fetched.Body)
		if err != nil {
			return nil, err
		}
		readback, err := server.CAS.ReadVerified(receipt.Hash)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(readback, fetched.Body) {
			return nil, errors.New("evidence CAS readback does not match the fetched response")
		}
		return server.DB.CaptureEvidenceFromMCP(ctx, capability.RunID, capability.StageAttemptID,
			fetched.FinalURL, arguments.Title, arguments.Publisher, fetched.MediaType, receipt)
	case "artifact_publish_plan", "artifact_publish_evidence", "artifact_publish_report", "artifact_publish_review":
		var arguments struct {
			capabilityArgs
			Content   string `json:"content"`
			MediaType string `json:"media_type"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil || arguments.Content == "" {
			return nil, errors.New("artifact content is required")
		}
		if len(arguments.Content) > maxArtifactBytes {
			return nil, errors.New("artifact content exceeds the allowed size")
		}
		if arguments.MediaType == "" {
			arguments.MediaType = "application/json"
		}
		receipt, err := server.CAS.PutBytes([]byte(arguments.Content))
		if err != nil {
			return nil, err
		}
		if _, err := server.CAS.ReadVerified(receipt.Hash); err != nil {
			return nil, err
		}
		kind := strings.TrimPrefix(name, "artifact_publish_")
		return server.DB.PublishArtifact(ctx, capability.RunID, capability.StageAttemptID,
			kind, arguments.MediaType, receipt)
	default:
		return nil, fmt.Errorf("tool %q is not available", name)
	}
}

type definitionBuilder func(name, description string, extra map[string]any, required ...string) map[string]any

func engineeringToolDefinitions(definition definitionBuilder) []map[string]any {
	number := func(minimum, maximum float64) map[string]any {
		return map[string]any{"type": "number", "minimum": minimum, "maximum": maximum}
	}
	integer := func(minimum, maximum int) map[string]any {
		return map[string]any{"type": "integer", "minimum": minimum, "maximum": maximum}
	}
	wing := map[string]any{
		"semi_span_m": number(.25, 100), "root_chord_m": number(.1, 25),
		"taper_ratio": number(.1, 1), "sweep_deg": number(-20, 65),
	}
	wingAero := make(map[string]any, len(wing)+5)
	for key, value := range wing {
		wingAero[key] = value
	}
	wingAero["mach"] = number(.01, .75)
	wingAero["alpha_start_deg"] = number(-15, 25)
	wingAero["alpha_end_deg"] = number(-15, 25)
	wingAero["alpha_points"] = integer(1, 21)
	mesh := make(map[string]any, len(wing)+1)
	for key, value := range wing {
		mesh[key] = value
	}
	mesh["mesh_size_m"] = number(.001, 12.5)
	return []map[string]any{
		definition("engineering_capabilities", "Return verified bundled engineering executables and readiness.", nil),
		definition("engineering_get", "Read one succeeded run-owned engineering job with compact scalar summary_metrics and copy-ready CAS-derived evidence_handles. Raw solver arrays remain in CAS.", map[string]any{
			"job_id": map[string]any{"type": "string", "minLength": 1},
		}, "job_id"),
		definition("openvsp_wing_aero", "Create a typed trapezoidal OpenVSP wing and run a VSPAERO alpha sweep.", wingAero,
			"semi_span_m", "root_chord_m", "taper_ratio", "sweep_deg", "mach", "alpha_start_deg", "alpha_end_deg", "alpha_points"),
		definition("openvsp_modify_wing", "Modify the sweep of an OpenVSP model artifact from this run.", map[string]any{
			"source_artifact_id": map[string]any{"type": "string", "minLength": 1},
			"new_sweep_deg":      number(-20, 65),
		}, "source_artifact_id", "new_sweep_deg"),
		definition("gmsh_wing_mesh", "Generate and coherence-check a trapezoidal wing planform mesh.", mesh,
			"semi_span_m", "root_chord_m", "taper_ratio", "sweep_deg", "mesh_size_m"),
		definition("xfoil_polar", "Run a viscous XFOIL polar for a NACA 4-digit airfoil, optionally with a sealed plain flap.", map[string]any{
			"naca":     map[string]any{"type": "string", "pattern": "^[0-9]{4}$"},
			"reynolds": number(5e4, 5e7), "mach": number(0, .7),
			"alpha_start_deg": number(-15, 20), "alpha_end_deg": number(-15, 20),
			"alpha_step_deg": number(.01, 5),
			"flap_chord_ratio": map[string]any{
				"type": "number", "minimum": .05, "maximum": .5,
				"description": "Plain-flap chord divided by airfoil chord; requires all four flap fields and must equal 1 - flap_hinge_x_over_c.",
			},
			"flap_hinge_x_over_c": map[string]any{
				"type": "number", "minimum": .5, "maximum": .95,
				"description": "Plain-flap hinge x/c; requires all four flap fields.",
			},
			"flap_hinge_y_over_c": map[string]any{
				"type": "number", "minimum": -.25, "maximum": .25,
				"description": "Plain-flap hinge y/c, which must lie strictly inside the base airfoil; requires all four flap fields.",
			},
			"flap_deflection_deg": map[string]any{
				"type": "number", "minimum": -40, "maximum": 40,
				"description": "XFOIL FLAP deflection in degrees; requires all four flap fields.",
			},
			"ncrit": map[string]any{
				"type": "number", "minimum": 1, "maximum": 14, "default": 9,
				"description": "e^N transition amplification factor.",
			},
			"iterations": map[string]any{
				"type": "integer", "minimum": 50, "maximum": 500, "default": 250,
				"description": "Maximum XFOIL viscous iterations per requested alpha.",
			},
			"panel_count": map[string]any{
				"type": "integer", "minimum": 80, "maximum": 300, "default": 160,
				"description": "XFOIL panel count applied before analysis. independent_verification must use the deterministic 50%-higher multiple of ten with a 240 floor (maximum 300), and must be greater than its screening source.",
			},
			"execution_purpose": map[string]any{
				"type": "string", "enum": []string{engineering.XFOILPurposeScreening, engineering.XFOILPurposeIndependentVerification},
				"description": "Use screening for optimization candidates. Use independent_verification only in the reserved verification stage; it must preserve invariant physics while independently refining panels and the target-alpha grid.",
			},
			"optimization_objective": map[string]any{
				"type": "string", "enum": []string{engineering.XFOILObjectiveMinimizeCDAtTargetCL},
				"description": "Required with screening or independent_verification; the backend deterministically selects the feasible minimum-CD candidate.",
			},
			"target_cl": map[string]any{
				"type": "number", "minimum": -5, "maximum": 5,
				"description": "Required lift coefficient for minimize_cd_at_target_cl interpolation.",
			},
			"minimum_cm": map[string]any{
				"type": "number", "minimum": -5, "maximum": 5,
				"description": "Required lower bound on the interpolated quarter-chord pitching moment.",
			},
			"verification_of_job_id": map[string]any{
				"type": "string", "minLength": 1,
				"description": "Required only for independent_verification and must name a succeeded screening XFOIL job from another collect attempt.",
			},
		}, "naca", "reynolds", "mach", "alpha_start_deg", "alpha_end_deg", "alpha_step_deg"),
		definition("su2_naca0012", "Generate a fixed NACA0012 mesh with Gmsh and run SU2_CFD OpenMP.", map[string]any{
			"mach": number(.05, .8), "alpha_deg": number(-10, 15),
			"iterations": integer(20, 1000), "mesh_size_m": number(.01, .2),
		}, "mach", "alpha_deg", "iterations", "mesh_size_m"),
	}
}

func (server *Server) callEngineering(
	ctx context.Context, name string, raw json.RawMessage, capability capabilityArgs,
) (any, error) {
	switch name {
	case "engineering_capabilities":
		return server.Engineering.Capabilities(ctx, capability.RunID, capability.StageAttemptID)
	case "engineering_get":
		var arguments struct {
			capabilityArgs
			JobID string `json:"job_id"`
		}
		if err := decodeStrictToolArgs(raw, &arguments); err != nil || strings.TrimSpace(arguments.JobID) == "" {
			return nil, errors.New("invalid engineering_get arguments")
		}
		return server.Engineering.EngineeringGet(ctx, capability.RunID, capability.StageAttemptID, arguments.JobID)
	case "openvsp_wing_aero":
		var spec engineering.WingSpec
		if err := decodeEngineeringArgs(raw, &spec); err != nil {
			return nil, errors.New("invalid OpenVSP/VSPAERO arguments")
		}
		return server.Engineering.OpenVSPWingAero(ctx, spec)
	case "openvsp_modify_wing":
		var spec engineering.ModifyWingSpec
		if err := decodeEngineeringArgs(raw, &spec); err != nil {
			return nil, errors.New("invalid OpenVSP modification arguments")
		}
		return server.Engineering.OpenVSPModifyWing(ctx, spec)
	case "gmsh_wing_mesh":
		var spec engineering.MeshSpec
		if err := decodeEngineeringArgs(raw, &spec); err != nil {
			return nil, errors.New("invalid Gmsh arguments")
		}
		return server.Engineering.GmshWingMesh(ctx, spec)
	case "xfoil_polar":
		var spec engineering.XFOILSpec
		if err := decodeEngineeringArgs(raw, &spec); err != nil {
			return nil, errors.New("invalid XFOIL arguments")
		}
		return server.Engineering.XFOILPolar(ctx, spec)
	case "su2_naca0012":
		var spec engineering.SU2Spec
		if err := decodeEngineeringArgs(raw, &spec); err != nil {
			return nil, errors.New("invalid SU2 arguments")
		}
		return server.Engineering.SU2NACA0012(ctx, spec)
	default:
		return nil, fmt.Errorf("engineering tool %q is not available", name)
	}
}

func decodeEngineeringArgs(raw json.RawMessage, target any) error {
	return decodeStrictToolArgs(raw, target)
}

func decodeStrictToolArgs(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("engineering arguments contain multiple JSON values")
		}
		return err
	}
	return nil
}

func toolResult(value any) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return toolError(err)
	}
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(encoded)}},
		"structuredContent": value,
		"isError":           false,
	}
}

type compactEngineeringSolverResult struct {
	JobID             string         `json:"job_id"`
	Operation         string         `json:"operation"`
	Status            string         `json:"status"`
	Executed          bool           `json:"executed"`
	ReusedResult      bool           `json:"reused_result"`
	NumericallyValid  bool           `json:"numerically_valid"`
	ReceiptArtifactID string         `json:"receipt_artifact_id"`
	SummaryMetrics    map[string]any `json:"summary_metrics"`
}

func toolResultFor(name string, value any) map[string]any {
	if !isEngineeringSolverTool(name) {
		return toolResult(value)
	}
	result, ok := value.(engineering.JobResult)
	if !ok {
		return toolError(errors.New("engineering solver returned an invalid result type"))
	}
	if result.Status == "succeeded" && strings.TrimSpace(result.ReceiptArtifactID) == "" {
		return toolError(errors.New("engineering solver result omits its receipt artifact id"))
	}
	compact := compactEngineeringSolverResult{
		JobID: result.JobID, Operation: result.Operation, Status: result.Status,
		Executed: result.Executed, ReusedResult: result.ReusedResult,
		NumericallyValid: result.NumericallyValid, ReceiptArtifactID: result.ReceiptArtifactID,
		SummaryMetrics: result.SummaryMetrics,
	}
	encoded, err := json.Marshal(compact)
	if err != nil {
		return toolError(err)
	}
	if len(encoded) > maxEngineeringSolverTextBytes {
		return toolError(errors.New("engineering solver compact result exceeds the allowed size"))
	}
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(encoded)}},
		"structuredContent": value,
		"isError":           false,
	}
}

func isEngineeringSolverTool(name string) bool {
	switch name {
	case "openvsp_wing_aero", "openvsp_modify_wing", "gmsh_wing_mesh", "xfoil_polar", "su2_naca0012":
		return true
	default:
		return false
	}
}

func toolError(err error) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": err.Error()}},
		"isError": true,
	}
}

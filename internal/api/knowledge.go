package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/knowledge"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	maxOntologyImportBytes        = 16 << 20
	maxOntologyJSONBodyBytes      = 23 << 20
	maxOntologyMultipartBodyBytes = maxOntologyImportBytes + (1 << 20)
	maxSPARQLQueryBytes           = 64 << 10
)

// KnowledgeController keeps the HTTP transport independent from the graph
// implementation. Every method is project-scoped; implementations must reject
// identifiers that belong to another project.
type KnowledgeController interface {
	Status(context.Context, string) (any, error)
	Search(context.Context, string, string, int) (any, error)
	Subgraph(context.Context, string, string, string, string, string, int, int) (any, error)
	Entity(context.Context, string, string) (any, error)
	Assertion(context.Context, string, string) (any, error)
	Evidence(context.Context, string, string) (any, error)
	SPARQL(context.Context, string, string, int) (any, error)
	ApplyEdit(context.Context, string, json.RawMessage) (any, error)
	ImportOntology(context.Context, string, string, string, []byte) (any, error)
	ActivateOntology(context.Context, string, string) (any, error)
	Rebuild(context.Context, string) (any, error)
	ExportJSONLD(context.Context, string) ([]byte, error)
	Materials(context.Context, string) (any, error)
	PinMaterial(context.Context, string, string, string, []byte, bool) (any, error)
	SetMaterialGraphAdopt(context.Context, string, string, bool) (any, error)
	DeleteMaterial(context.Context, string, string, string) (any, error)
}

func (server *Server) handleKnowledgePath(writer http.ResponseWriter, request *http.Request, parts []string) {
	if server.Knowledge == nil {
		writeError(writer, http.StatusServiceUnavailable, "knowledge_unavailable", "knowledge graph is not configured")
		return
	}
	projectID := parts[0]
	if projectID == "" {
		writeError(writer, http.StatusBadRequest, "invalid_project", "project id is required")
		return
	}
	ctx := request.Context()
	if len(parts) == 3 {
		switch parts[2] {
		case "status":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Status(ctx, projectID) })
			return
		case "search":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			limit := boundedInt(request.URL.Query().Get("limit"), 12, 1, 50)
			query := strings.TrimSpace(request.URL.Query().Get("q"))
			if query == "" {
				writeError(writer, http.StatusBadRequest, "invalid_query", "q is required")
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Search(ctx, projectID, query, limit) })
			return
		case "subgraph":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			values := request.URL.Query()
			mode := strings.TrimSpace(values.Get("mode"))
			if mode == "" {
				mode = "instance"
			}
			if mode != "instance" && mode != "ontology" {
				writeError(writer, http.StatusBadRequest, "invalid_knowledge_mode", "mode must be instance or ontology")
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) {
				return server.Knowledge.Subgraph(ctx, projectID, mode, strings.TrimSpace(values.Get("ontology_id")),
					strings.TrimSpace(values.Get("q")), strings.TrimSpace(values.Get("entity_id")),
					boundedInt(values.Get("max_nodes"), 100, 1, 500), boundedInt(values.Get("max_edges"), 200, 1, 1000))
			})
			return
		case "sparql":
			if request.Method != http.MethodPost {
				methodNotAllowed(writer)
				return
			}
			var body struct {
				Query   string `json:"query"`
				MaxRows int    `json:"max_rows"`
			}
			if err := decodeJSON(request, &body); err != nil || strings.TrimSpace(body.Query) == "" || len(body.Query) > maxSPARQLQueryBytes {
				writeError(writer, http.StatusBadRequest, "invalid_sparql", "a query up to 64 KiB is required")
				return
			}
			if err := knowledge.ValidateReadOnlySPARQL(body.Query); err != nil {
				writeError(writer, http.StatusBadRequest, "invalid_sparql", err.Error())
				return
			}
			if body.MaxRows <= 0 || body.MaxRows > 1000 {
				body.MaxRows = 1000
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.SPARQL(ctx, projectID, body.Query, body.MaxRows) })
			return
		case "edits":
			if request.Method != http.MethodPost {
				methodNotAllowed(writer)
				return
			}
			data, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBytes+1))
			if err != nil || len(data) == 0 || len(data) > maxRequestBytes || !json.Valid(data) {
				writeError(writer, http.StatusBadRequest, "invalid_edit_patch", "a valid evidence-backed JSON edit patch is required")
				return
			}
			server.writeKnowledgeCall(writer, http.StatusCreated, func() (any, error) { return server.Knowledge.ApplyEdit(ctx, projectID, json.RawMessage(data)) })
			return
		case "rebuild":
			if request.Method != http.MethodPost {
				methodNotAllowed(writer)
				return
			}
			server.writeKnowledgeCall(writer, http.StatusAccepted, func() (any, error) { return server.Knowledge.Rebuild(ctx, projectID) })
			return
		case "export":
			if request.Method != http.MethodGet || request.URL.Query().Get("format") != "jsonld" {
				if request.Method != http.MethodGet {
					methodNotAllowed(writer)
				} else {
					writeError(writer, http.StatusBadRequest, "unsupported_export", "format must be jsonld")
				}
				return
			}
			data, err := server.Knowledge.ExportJSONLD(ctx, projectID)
			if err != nil {
				writeKnowledgeError(writer, err)
				return
			}
			writer.Header().Set("Content-Type", "application/ld+json")
			writer.Header().Set("Content-Disposition", `attachment; filename="aetherops-knowledge.jsonld"`)
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write(data)
			return
		case "materials":
			switch request.Method {
			case http.MethodGet:
				server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Materials(ctx, projectID) })
			case http.MethodPost:
				var body struct {
					Title         string `json:"title"`
					Filename      string `json:"filename"`
					MediaType     string `json:"media_type"`
					ContentBase64 string `json:"content_base64"`
					GraphAdopt    bool   `json:"graph_adopt"`
				}
				if err := decodeJSONLimited(request, &body, (maxOntologyImportBytes*2)+1); err != nil {
					writeError(writer, http.StatusBadRequest, "invalid_material", "invalid pinned material payload")
					return
				}
				data, err := base64.StdEncoding.DecodeString(body.ContentBase64)
				if err != nil || len(data) == 0 || len(data) > maxOntologyImportBytes {
					writeError(writer, http.StatusBadRequest, "invalid_material", "material must contain base64 bytes up to 16 MiB")
					return
				}
				server.writeKnowledgeCall(writer, http.StatusCreated, func() (any, error) {
					mediaType := resolvePinnedMaterialMediaType(body.Filename, body.Title, body.MediaType)
					return server.Knowledge.PinMaterial(ctx, projectID, strings.TrimSpace(body.Title), mediaType, data, body.GraphAdopt)
				})
			default:
				methodNotAllowed(writer)
			}
			return
		}
	}
	if len(parts) == 4 {
		switch parts[2] {
		case "materials":
			switch request.Method {
			case http.MethodPatch:
				var body struct {
					GraphAdopt *bool `json:"graph_adopt"`
				}
				if err := decodeJSON(request, &body); err != nil || body.GraphAdopt == nil {
					writeError(writer, http.StatusBadRequest, "invalid_material_patch", "graph_adopt is required")
					return
				}
				server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) {
					return server.Knowledge.SetMaterialGraphAdopt(ctx, projectID, parts[3], *body.GraphAdopt)
				})
			case http.MethodDelete:
				var body struct {
					DocumentID   string `json:"document_id"`
					ConfirmTitle string `json:"confirm_title"`
				}
				if err := decodeJSON(request, &body); err != nil || body.DocumentID != parts[3] || body.ConfirmTitle == "" {
					writeError(writer, http.StatusBadRequest, "invalid_deletion_confirmation", "document_id and the exact material title are required")
					return
				}
				server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) {
					return server.Knowledge.DeleteMaterial(ctx, projectID, parts[3], body.ConfirmTitle)
				})
			default:
				methodNotAllowed(writer)
			}
			return
		case "entities":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Entity(ctx, projectID, parts[3]) })
			return
		case "assertions":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Assertion(ctx, projectID, parts[3]) })
			return
		case "evidence":
			if request.Method != http.MethodGet {
				methodNotAllowed(writer)
				return
			}
			server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.Evidence(ctx, projectID, parts[3]) })
			return
		case "ontology":
			if parts[3] == "import" {
				if request.Method != http.MethodPost {
					methodNotAllowed(writer)
					return
				}
				name, format, data, err := decodeOntologyImport(request)
				if err != nil {
					writeError(writer, http.StatusBadRequest, "invalid_ontology_import", err.Error())
					return
				}
				server.writeKnowledgeCall(writer, http.StatusCreated, func() (any, error) { return server.Knowledge.ImportOntology(ctx, projectID, name, format, data) })
				return
			}
		}
	}
	if len(parts) == 5 && parts[2] == "ontology" && parts[4] == "activate" {
		if request.Method != http.MethodPost {
			methodNotAllowed(writer)
			return
		}
		server.writeKnowledgeCall(writer, http.StatusOK, func() (any, error) { return server.Knowledge.ActivateOntology(ctx, projectID, parts[3]) })
		return
	}
	http.NotFound(writer, request)
}

func resolvePinnedMaterialMediaType(filename, title, claimed string) string {
	claimed = strings.TrimSpace(claimed)
	base, _, err := mime.ParseMediaType(claimed)
	if err == nil && base != "" && base != "application/octet-stream" {
		return claimed
	}
	name := strings.TrimSpace(filename)
	if name == "" {
		name = strings.TrimSpace(title)
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".txt", ".log":
		return "text/plain; charset=utf-8"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	default:
		return claimed
	}
}

func decodeOntologyImport(request *http.Request) (string, string, []byte, error) {
	contentType := request.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if request.ContentLength > maxOntologyMultipartBodyBytes {
			return "", "", nil, errors.New("ontology multipart request is too large")
		}
		originalBody := request.Body
		defer originalBody.Close()
		request.Body = io.NopCloser(io.LimitReader(originalBody, maxOntologyMultipartBodyBytes+1))
		if err := request.ParseMultipartForm(maxOntologyImportBytes); err != nil {
			return "", "", nil, err
		}
		if request.MultipartForm != nil {
			defer request.MultipartForm.RemoveAll()
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			return "", "", nil, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, maxOntologyImportBytes+1))
		if err != nil {
			return "", "", nil, err
		}
		if len(data) == 0 || len(data) > maxOntologyImportBytes {
			return "", "", nil, errors.New("ontology must be between 1 byte and 16 MiB")
		}
		return header.Filename, strings.TrimSpace(request.FormValue("format")), data, nil
	}
	var body struct {
		Name          string `json:"name"`
		Filename      string `json:"filename"`
		Format        string `json:"format"`
		MediaType     string `json:"media_type"`
		ContentBase64 string `json:"content_base64"`
	}
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxOntologyJSONBodyBytes+1))
	if err != nil {
		return "", "", nil, err
	}
	if len(payload) > maxOntologyJSONBodyBytes {
		return "", "", nil, errors.New("ontology JSON request is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return "", "", nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return "", "", nil, errors.New("ontology request must contain one JSON value")
		}
		return "", "", nil, err
	}
	data, err := base64.StdEncoding.DecodeString(body.ContentBase64)
	if err != nil {
		return "", "", nil, errors.New("content_base64 is invalid")
	}
	if len(data) == 0 || len(data) > maxOntologyImportBytes {
		return "", "", nil, errors.New("ontology must be between 1 byte and 16 MiB")
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = strings.TrimSpace(body.Filename)
	}
	format := strings.TrimSpace(body.Format)
	if format == "" {
		format = strings.TrimSpace(body.MediaType)
	}
	return name, format, data, nil
}

func boundedInt(raw string, fallback, minimum, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return fallback
	}
	return value
}

func (server *Server) writeKnowledgeCall(writer http.ResponseWriter, status int, call func() (any, error)) {
	value, err := call()
	if err != nil {
		writeKnowledgeError(writer, err)
		return
	}
	writeJSON(writer, status, value)
}

func writeKnowledgeError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, sql.ErrNoRows):
		writeError(writer, http.StatusNotFound, "knowledge_not_found", "knowledge object was not found in this project")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(writer, http.StatusGatewayTimeout, "knowledge_timeout", "knowledge operation timed out without partial results")
	default:
		writeError(writer, http.StatusConflict, "knowledge_rejected", err.Error())
	}
}

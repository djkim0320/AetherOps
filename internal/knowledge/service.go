package knowledge

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/memory"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type Service struct {
	DB      *store.DB
	CAS     *cas.Store
	Memory  *memory.Service
	Sidecar *Sidecar
	// Extraction is the only model-facing boundary used to adopt pinned prose.
	// It must create isolated Codex App Server threads and return schema-bound
	// JSON; a missing protocol is a hard error whenever a document needs
	// extraction.
	Extraction ExtractionProtocol

	rebuildMu  sync.Mutex
	rebuilding map[string]bool

	// durabilityTestCheckpoint is intentionally unexported and nil in every
	// product construction path. Same-package subprocess tests use it to call
	// os.Exit at exact commit boundaries without exposing an environment-driven
	// crash switch in the AetherOps executable.
	durabilityTestCheckpoint func(string)
}

func (service *Service) checkpointDurabilityTest(name string) {
	if service.durabilityTestCheckpoint != nil {
		service.durabilityTestCheckpoint(name)
	}
}

type Status struct {
	Ready                   bool                      `json:"ready"`
	State                   store.KnowledgeHeadStatus `json:"state"`
	Error                   string                    `json:"error,omitempty"`
	KnowledgeRevision       int64                     `json:"knowledge_revision"`
	Generation              store.KnowledgeGeneration `json:"generation"`
	ActiveOntologyVersionID string                    `json:"active_ontology_version_id"`
	OntologyVersions        []map[string]any          `json:"ontology_versions"`
	EntityCount             int                       `json:"entity_count"`
	AssertionCount          int                       `json:"assertion_count"`
	EvidenceCount           int                       `json:"evidence_count"`
	ConflictCount           int                       `json:"conflict_count"`
}

type EntityView struct {
	ID                  string           `json:"id"`
	ClassKey            string           `json:"class_key"`
	CanonicalName       string           `json:"canonical_name"`
	Description         string           `json:"description,omitempty"`
	IdentityKey         string           `json:"identity_key,omitempty"`
	Pinned              bool             `json:"pinned"`
	Aliases             []map[string]any `json:"aliases"`
	InferredTypes       []map[string]any `json:"inferred_types"`
	Assertions          []AssertionView  `json:"assertions"`
	AssertionCount      int              `json:"assertion_count"`
	AssertionsTruncated bool             `json:"assertions_truncated"`
}

type AssertionView struct {
	ID              string           `json:"id"`
	SubjectEntityID string           `json:"subject_entity_id"`
	PredicateKey    string           `json:"predicate_key"`
	ObjectEntityID  string           `json:"object_entity_id,omitempty"`
	Literal         json.RawMessage  `json:"literal,omitempty"`
	Qualifiers      json.RawMessage  `json:"qualifiers"`
	Polarity        string           `json:"polarity"`
	ValidFrom       string           `json:"valid_from,omitempty"`
	ValidTo         string           `json:"valid_to,omitempty"`
	Status          string           `json:"status"`
	Evidence        []EvidenceView   `json:"evidence"`
	Proofs          []map[string]any `json:"proofs"`
	Conflicts       []map[string]any `json:"conflicts"`
}

type EvidenceView struct {
	ID           string          `json:"id"`
	AssertionID  string          `json:"assertion_id"`
	Kind         string          `json:"kind"`
	BlobHash     string          `json:"blob_hash"`
	ChunkID      string          `json:"chunk_id,omitempty"`
	ClaimID      string          `json:"claim_id,omitempty"`
	SourceID     string          `json:"source_id,omitempty"`
	StartByte    *int            `json:"start_byte,omitempty"`
	EndByte      *int            `json:"end_byte,omitempty"`
	Locator      json.RawMessage `json:"locator,omitempty"`
	Excerpt      string          `json:"excerpt,omitempty"`
	EvidenceHash string          `json:"evidence_sha256"`
}

type Subgraph struct {
	Mode       string           `json:"mode,omitempty"`
	OntologyID string           `json:"ontology_id,omitempty"`
	State      string           `json:"ontology_state,omitempty"`
	Nodes      []map[string]any `json:"nodes"`
	Edges      []map[string]any `json:"edges"`
	TotalNodes int              `json:"total_nodes"`
	TotalEdges int              `json:"total_edges"`
	Truncated  bool             `json:"truncated"`
}

func (service *Service) configured() error {
	if service.DB == nil || service.CAS == nil {
		return errors.New("knowledge service storage is not configured")
	}
	return nil
}

func knowledgeLookupError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}

func (service *Service) Status(ctx context.Context, projectID string) (any, error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return nil, knowledgeLookupError(err)
	}
	status := Status{
		Ready: head.Status == store.KnowledgeHeadReady && head.Generation.State == store.KnowledgeReady,
		State: head.Status, Error: head.Error, KnowledgeRevision: head.KnowledgeRevision,
		Generation: head.Generation, EntityCount: head.Generation.EntityCount,
		AssertionCount: head.Generation.AssertionCount,
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT id,COALESCE(project_id,''),semantic_version,state,canonical_sha256,triple_count FROM ontology_versions WHERE project_id IS NULL OR project_id=? ORDER BY created_at,id`, projectID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, ontologyProjectID, version, state, hash string
		var count int
		if err := rows.Scan(&id, &ontologyProjectID, &version, &state, &hash, &count); err != nil {
			rows.Close()
			return nil, err
		}
		status.OntologyVersions = append(status.OntologyVersions, map[string]any{"id": id, "project_id": ontologyProjectID, "semantic_version": version, "state": state, "canonical_sha256": hash, "triple_count": count})
		if state == "active" && (status.ActiveOntologyVersionID == "" || ontologyProjectID == projectID) {
			status.ActiveOntologyVersionID = id
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=?`, projectID, head.GenerationID).Scan(&status.EvidenceCount); err != nil {
		return nil, err
	}
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_conflicts WHERE project_id=? AND generation_id=? AND status='open'`, projectID, head.GenerationID).Scan(&status.ConflictCount); err != nil {
		return nil, err
	}
	return status, nil
}

func (service *Service) readyHead(ctx context.Context, projectID string) (store.KnowledgeHead, error) {
	head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return store.KnowledgeHead{}, knowledgeLookupError(err)
	}
	if head.Status != store.KnowledgeHeadReady || head.Generation.State != store.KnowledgeReady {
		return store.KnowledgeHead{}, fmt.Errorf("knowledge graph is not ready: %s/%s", head.Status, head.Generation.State)
	}
	return head, nil
}

func (service *Service) Search(ctx context.Context, projectID, query string, limit int) (any, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 50 {
		limit = 50
	}
	pattern := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT e.id,e.class_key,e.canonical_name,e.description,
       CASE WHEN lower(e.canonical_name)=lower(?) THEN 2.0 ELSE 1.0 END AS score
FROM knowledge_entities e
WHERE e.project_id=? AND e.generation_id=? AND (
 lower(e.canonical_name) LIKE ? OR EXISTS(SELECT 1 FROM knowledge_aliases a
  WHERE a.project_id=e.project_id AND a.generation_id=e.generation_id AND a.entity_id=e.id
    AND lower(a.alias) LIKE ?))
ORDER BY score DESC,e.canonical_name,e.id LIMIT ?`, query, projectID, head.GenerationID, pattern, pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []map[string]any{}
	for rows.Next() {
		var id, classKey, name, description string
		var score float64
		if err := rows.Scan(&id, &classKey, &name, &description, &score); err != nil {
			return nil, err
		}
		results = append(results, map[string]any{"id": id, "label": name, "kind": classKey, "description": description, "score": score})
	}
	return map[string]any{"results": results, "generation_id": head.GenerationID}, rows.Err()
}

func (service *Service) Subgraph(ctx context.Context, projectID, mode, ontologyID, query, entityID string, maxNodes, maxEdges int) (any, error) {
	if mode == "ontology" {
		return service.ontologySubgraph(ctx, projectID, ontologyID, query, entityID, maxNodes, maxEdges)
	}
	if mode != "" && mode != "instance" {
		return nil, errors.New("knowledge subgraph mode must be instance or ontology")
	}
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if maxNodes <= 0 || maxNodes > 500 {
		maxNodes = 500
	}
	if maxEdges <= 0 || maxEdges > 1000 {
		maxEdges = 1000
	}
	seeds := []string{}
	if entityID != "" {
		seeds = []string{entityID}
	} else {
		searched, err := service.Search(ctx, projectID, query, min(8, maxNodes))
		if err != nil {
			return nil, err
		}
		for _, item := range searched.(map[string]any)["results"].([]map[string]any) {
			seeds = append(seeds, item["id"].(string))
		}
	}
	if len(seeds) == 0 {
		return Subgraph{Nodes: []map[string]any{}, Edges: []map[string]any{}}, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(seeds)), ",")
	arguments := []any{projectID, head.GenerationID}
	for _, seed := range seeds {
		arguments = append(arguments, seed)
	}
	for _, seed := range seeds {
		arguments = append(arguments, seed)
	}
	arguments = append(arguments, maxEdges+1)
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT a.id,a.subject_entity_id,a.predicate_key,a.object_entity_id,a.status,
       COALESCE(a.valid_from,''),COALESCE(a.valid_to,''),
       EXISTS(
         SELECT 1 FROM knowledge_conflicts c
         WHERE c.project_id=a.project_id AND c.generation_id=a.generation_id
           AND c.status='open'
           AND (c.left_assertion_id=a.id OR c.right_assertion_id=a.id)
       ) AS has_open_conflict
FROM knowledge_assertions a WHERE a.project_id=? AND a.generation_id=?
 AND a.object_entity_id IS NOT NULL AND a.status IN ('accepted','disputed')
 AND (a.subject_entity_id IN (`+placeholders+`) OR a.object_entity_id IN (`+placeholders+`))
ORDER BY a.id LIMIT ?`, arguments...)
	if err != nil {
		return nil, err
	}
	nodeIDs := map[string]bool{}
	for _, seed := range seeds {
		nodeIDs[seed] = true
	}
	edges := []map[string]any{}
	truncated := false
	conflictedNodes := map[string]bool{}
	for rows.Next() {
		var id, subject, predicate, object, status, validFrom, validTo string
		var hasOpenConflict int
		if err := rows.Scan(&id, &subject, &predicate, &object, &status, &validFrom, &validTo, &hasOpenConflict); err != nil {
			rows.Close()
			return nil, err
		}
		if len(edges) >= maxEdges {
			truncated = true
			continue
		}
		nodeIDs[subject] = true
		nodeIDs[object] = true
		conflict := status == "disputed" || hasOpenConflict != 0
		if conflict {
			conflictedNodes[subject] = true
			conflictedNodes[object] = true
		}
		edges = append(edges, map[string]any{
			"id": id, "source": subject, "target": object, "label": predicate,
			"predicate": predicate, "assertion_id": id, "status": status,
			"valid_from": validFrom, "valid_to": validTo, "conflict": conflict,
		})
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(nodeIDs))
	for id := range nodeIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > maxNodes {
		ids = ids[:maxNodes]
		truncated = true
	}
	allowed := map[string]bool{}
	for _, id := range ids {
		allowed[id] = true
	}
	filtered := edges[:0]
	for _, edge := range edges {
		if allowed[edge["source"].(string)] && allowed[edge["target"].(string)] {
			filtered = append(filtered, edge)
		}
	}
	edges = filtered
	pins, err := service.entityPins(ctx, projectID, ids)
	if err != nil {
		return nil, err
	}
	inferredTypes := map[string][]string{}
	typeArguments := []any{projectID, head.GenerationID}
	for _, id := range ids {
		typeArguments = append(typeArguments, id)
	}
	typeRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT entity_id,class_key FROM knowledge_type_inferences
WHERE project_id=? AND generation_id=? AND status='accepted'
  AND entity_id IN (`+strings.TrimRight(strings.Repeat("?,", len(ids)), ",")+`)
ORDER BY entity_id,class_key`, typeArguments...)
	if err != nil {
		return nil, err
	}
	for typeRows.Next() {
		var id, classKey string
		if err := typeRows.Scan(&id, &classKey); err != nil {
			typeRows.Close()
			return nil, err
		}
		inferredTypes[id] = append(inferredTypes[id], classKey)
	}
	if err := typeRows.Close(); err != nil {
		return nil, err
	}
	nodes := []map[string]any{}
	for _, id := range ids {
		var classKey, name, description string
		if err := service.DB.SQL().QueryRowContext(ctx, `SELECT class_key,canonical_name,description FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`, projectID, head.GenerationID, id).Scan(&classKey, &name, &description); err != nil {
			return nil, knowledgeLookupError(err)
		}
		types := append([]string{classKey}, inferredTypes[id]...)
		nodes = append(nodes, map[string]any{"id": id, "label": name, "kind": classKey, "types": types, "description": description, "conflict": conflictedNodes[id], "pinned": pins[id]})
	}
	return Subgraph{Nodes: nodes, Edges: edges, TotalNodes: len(nodeIDs), TotalEdges: len(edges), Truncated: truncated}, nil
}

type ontologyGraphTerm struct {
	Key, IRI, Kind, Label, Description, Domain, Range, ValueKind string
	Functional, Temporal, Expandable                             bool
}

func ontologyGraphNode(term ontologyGraphTerm) map[string]any {
	return map[string]any{
		"id": term.Key, "iri": term.IRI, "label": term.Label, "kind": "ontology",
		"types": []string{term.Kind}, "term_kind": term.Kind, "description": term.Description,
		"domain_key": term.Domain, "range_key": term.Range, "value_kind": term.ValueKind,
		"functional": term.Functional, "temporal": term.Temporal, "expandable": term.Expandable,
		"conflict": false,
	}
}

func scanOntologyGraphTerm(scanner interface{ Scan(...any) error }) (ontologyGraphTerm, error) {
	var term ontologyGraphTerm
	var functional, temporal, expandable int
	err := scanner.Scan(&term.Key, &term.IRI, &term.Kind, &term.Label, &term.Description,
		&term.Domain, &term.Range, &term.ValueKind, &functional, &temporal, &expandable)
	term.Functional, term.Temporal, term.Expandable = functional != 0, temporal != 0, expandable != 0
	return term, err
}

func (service *Service) ontologySubgraph(ctx context.Context, projectID, ontologyID, query, entityID string, maxNodes, maxEdges int) (any, error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	if maxNodes <= 0 || maxNodes > 500 {
		maxNodes = 500
	}
	if maxEdges <= 0 || maxEdges > 1000 {
		maxEdges = 1000
	}
	var projectExists int
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM projects WHERE id=?`, projectID).Scan(&projectExists); err != nil {
		return nil, err
	}
	if projectExists != 1 {
		return nil, store.ErrNotFound
	}
	if ontologyID == "" {
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT id FROM ontology_versions
WHERE state='active' AND (project_id=? OR project_id IS NULL)
ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END,created_at DESC LIMIT 1`, projectID, projectID).Scan(&ontologyID); err != nil {
			return nil, knowledgeLookupError(err)
		}
	}
	var ontologyProject sql.NullString
	var ontologyState string
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT project_id,state FROM ontology_versions
WHERE id=? AND (project_id=? OR project_id IS NULL)`, ontologyID, projectID).Scan(&ontologyProject, &ontologyState); err != nil {
		return nil, knowledgeLookupError(err)
	}

	var totalNodes, totalEdges int
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ontology_terms WHERE ontology_id=?`, ontologyID).Scan(&totalNodes); err != nil {
		return nil, err
	}
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ontology_axioms WHERE ontology_id=? AND axiom_type<>'annotation'`, ontologyID).Scan(&totalEdges); err != nil {
		return nil, err
	}

	termQuery := `SELECT term_key,iri,kind,label,description,domain_key,range_key,value_kind,functional,temporal,expandable
FROM ontology_terms WHERE ontology_id=?`
	arguments := []any{ontologyID}
	if entityID != "" {
		termQuery += ` AND term_key=?`
		arguments = append(arguments, entityID)
	} else if strings.TrimSpace(query) != "" {
		pattern := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
		termQuery += ` AND (lower(term_key) LIKE ? OR lower(iri) LIKE ? OR lower(label) LIKE ? OR lower(description) LIKE ?)`
		arguments = append(arguments, pattern, pattern, pattern, pattern)
	}
	termQuery += ` ORDER BY term_key LIMIT ?`
	arguments = append(arguments, maxNodes+1)
	termRows, err := service.DB.SQL().QueryContext(ctx, termQuery, arguments...)
	if err != nil {
		return nil, err
	}
	nodesByID := map[string]map[string]any{}
	seedIDs := []string{}
	truncated := false
	for termRows.Next() {
		term, err := scanOntologyGraphTerm(termRows)
		if err != nil {
			termRows.Close()
			return nil, err
		}
		if len(seedIDs) >= maxNodes {
			truncated = true
			continue
		}
		seedIDs = append(seedIDs, term.Key)
		nodesByID[term.Key] = ontologyGraphNode(term)
	}
	if err := termRows.Close(); err != nil {
		return nil, err
	}
	if entityID != "" && len(seedIDs) == 0 {
		return nil, store.ErrNotFound
	}
	if len(seedIDs) == 0 {
		return Subgraph{Mode: "ontology", OntologyID: ontologyID, State: ontologyState, Nodes: []map[string]any{}, Edges: []map[string]any{}, TotalNodes: totalNodes, TotalEdges: totalEdges}, nil
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(seedIDs)), ",")
	edgeArguments := []any{ontologyID}
	for _, seed := range seedIDs {
		edgeArguments = append(edgeArguments, seed)
	}
	for _, seed := range seedIDs {
		edgeArguments = append(edgeArguments, seed)
	}
	edgeArguments = append(edgeArguments, maxEdges+1)
	edgeRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,axiom_type,subject_key,object_key
FROM ontology_axioms
WHERE ontology_id=? AND axiom_type<>'annotation'
  AND (subject_key IN (`+placeholders+`) OR object_key IN (`+placeholders+`))
ORDER BY id LIMIT ?`, edgeArguments...)
	if err != nil {
		return nil, err
	}
	type ontologyEdge struct{ id, kind, source, target string }
	rawEdges := []ontologyEdge{}
	for edgeRows.Next() {
		var edge ontologyEdge
		if err := edgeRows.Scan(&edge.id, &edge.kind, &edge.source, &edge.target); err != nil {
			edgeRows.Close()
			return nil, err
		}
		if len(rawEdges) >= maxEdges {
			truncated = true
			continue
		}
		if edge.target == "" {
			edge.target = edge.source
		}
		rawEdges = append(rawEdges, edge)
	}
	if err := edgeRows.Close(); err != nil {
		return nil, err
	}

	loadTerm := func(key string) error {
		if _, ok := nodesByID[key]; ok {
			return nil
		}
		if len(nodesByID) >= maxNodes {
			truncated = true
			return nil
		}
		term, err := scanOntologyGraphTerm(service.DB.SQL().QueryRowContext(ctx, `
SELECT term_key,iri,kind,label,description,domain_key,range_key,value_kind,functional,temporal,expandable
FROM ontology_terms WHERE ontology_id=? AND term_key=?`, ontologyID, key))
		if errors.Is(err, sql.ErrNoRows) {
			nodesByID[key] = map[string]any{"id": key, "iri": key, "label": iriLocalName(key), "kind": "ontology", "types": []string{"datatype"}, "term_kind": "datatype", "conflict": false}
			return nil
		}
		if err != nil {
			return err
		}
		nodesByID[key] = ontologyGraphNode(term)
		return nil
	}
	for _, edge := range rawEdges {
		if err := loadTerm(edge.source); err != nil {
			return nil, err
		}
		if err := loadTerm(edge.target); err != nil {
			return nil, err
		}
	}
	edges := []map[string]any{}
	for _, edge := range rawEdges {
		if nodesByID[edge.source] == nil || nodesByID[edge.target] == nil {
			truncated = true
			continue
		}
		edges = append(edges, map[string]any{"id": edge.id, "source": edge.source, "target": edge.target, "label": edge.kind, "predicate": edge.kind, "conflict": false})
	}
	nodeIDs := make([]string, 0, len(nodesByID))
	for id := range nodesByID {
		nodeIDs = append(nodeIDs, id)
	}
	sort.Strings(nodeIDs)
	nodes := make([]map[string]any, 0, len(nodeIDs))
	for _, id := range nodeIDs {
		nodes = append(nodes, nodesByID[id])
	}
	return Subgraph{Mode: "ontology", OntologyID: ontologyID, State: ontologyState, Nodes: nodes, Edges: edges, TotalNodes: totalNodes, TotalEdges: totalEdges, Truncated: truncated}, nil
}

func (service *Service) Entity(ctx context.Context, projectID, entityID string) (any, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return service.EntityGeneration(ctx, projectID, head.GenerationID, entityID)
}

func (service *Service) EntityGeneration(ctx context.Context, projectID, generationID, entityID string) (any, error) {
	generation, err := service.DB.KnowledgeGeneration(ctx, projectID, generationID)
	if err != nil {
		return nil, knowledgeLookupError(err)
	}
	if generation.State != store.KnowledgeReady && generation.State != store.KnowledgeRetired {
		return nil, fmt.Errorf("knowledge generation is not readable: %s", generation.State)
	}
	head := store.KnowledgeHead{GenerationID: generationID}
	var entity EntityView
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT id,class_key,canonical_name,description,identity_key FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`, projectID, head.GenerationID, entityID).Scan(&entity.ID, &entity.ClassKey, &entity.CanonicalName, &entity.Description, &entity.IdentityKey); err != nil {
		return nil, knowledgeLookupError(err)
	}
	pins, err := service.entityPins(ctx, projectID, []string{entityID})
	if err != nil {
		return nil, err
	}
	entity.Pinned = pins[entityID]
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT alias,language FROM knowledge_aliases WHERE project_id=? AND generation_id=? AND entity_id=? ORDER BY language,alias`, projectID, head.GenerationID, entityID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var alias, language string
		if err := rows.Scan(&alias, &language); err != nil {
			rows.Close()
			return nil, err
		}
		entity.Aliases = append(entity.Aliases, map[string]any{"value": alias, "language": language})
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	typeRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT i.id,i.class_key,i.rule_axiom_id,p.ordinal,p.premise_kind,
       COALESCE(p.premise_entity_id,''),p.premise_class_key,
       COALESCE(p.premise_assertion_id,''),COALESCE(p.premise_type_inference_id,'')
FROM knowledge_type_inferences i
JOIN knowledge_type_inference_proofs p
  ON p.project_id=i.project_id AND p.generation_id=i.generation_id AND p.inference_id=i.id
WHERE i.project_id=? AND i.generation_id=? AND i.entity_id=? AND i.status='accepted'
ORDER BY i.class_key,i.id,p.ordinal`, projectID, head.GenerationID, entityID)
	if err != nil {
		return nil, err
	}
	byInference := map[string]map[string]any{}
	var typeOrder []string
	for typeRows.Next() {
		var inferenceID, classKey, ruleID, kind, premiseEntity, premiseClass, premiseAssertion, premiseType string
		var ordinal int
		if err := typeRows.Scan(&inferenceID, &classKey, &ruleID, &ordinal, &kind,
			&premiseEntity, &premiseClass, &premiseAssertion, &premiseType); err != nil {
			typeRows.Close()
			return nil, err
		}
		item, exists := byInference[inferenceID]
		if !exists {
			item = map[string]any{"inference_id": inferenceID, "class_key": classKey, "rule_id": ruleID, "proofs": []map[string]any{}}
			byInference[inferenceID] = item
			typeOrder = append(typeOrder, inferenceID)
		}
		proof := map[string]any{"ordinal": ordinal, "premise_kind": kind}
		if premiseEntity != "" {
			proof["premise_entity_id"], proof["premise_class_key"] = premiseEntity, premiseClass
		}
		if premiseAssertion != "" {
			proof["premise_assertion_id"] = premiseAssertion
		}
		if premiseType != "" {
			proof["premise_type_inference_id"] = premiseType
		}
		item["proofs"] = append(item["proofs"].([]map[string]any), proof)
	}
	if err := typeRows.Close(); err != nil {
		return nil, err
	}
	for _, inferenceID := range typeOrder {
		entity.InferredTypes = append(entity.InferredTypes, byInference[inferenceID])
	}
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_assertions
WHERE project_id=? AND generation_id=? AND (subject_entity_id=? OR object_entity_id=?)`,
		projectID, head.GenerationID, entityID, entityID).Scan(&entity.AssertionCount); err != nil {
		return nil, err
	}
	entity.AssertionsTruncated = entity.AssertionCount > 200
	assertionRows, err := service.DB.SQL().QueryContext(ctx, `SELECT id FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND (subject_entity_id=? OR object_entity_id=?) ORDER BY id LIMIT 200`, projectID, head.GenerationID, entityID, entityID)
	if err != nil {
		return nil, err
	}
	for assertionRows.Next() {
		var id string
		if err := assertionRows.Scan(&id); err != nil {
			assertionRows.Close()
			return nil, err
		}
		view, err := service.assertion(ctx, projectID, head.GenerationID, id)
		if err != nil {
			assertionRows.Close()
			return nil, err
		}
		entity.Assertions = append(entity.Assertions, view)
	}
	if err := assertionRows.Close(); err != nil {
		return nil, err
	}
	return entity, nil
}

// entityPins projects the latest append-only pin event for each requested
// project entity in one ledger scan. Pin metadata deliberately is not copied
// into immutable generation rows: the curation ledger remains authoritative
// across shadow rebuilds and process restarts.
func (service *Service) entityPins(ctx context.Context, projectID string, entityIDs []string) (map[string]bool, error) {
	wanted := make(map[string]bool, len(entityIDs))
	for _, entityID := range entityIDs {
		wanted[entityID] = true
	}
	result := make(map[string]bool, len(entityIDs))
	if len(wanted) == 0 {
		return result, nil
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT payload_json FROM knowledge_curation_events
WHERE project_id=? AND kind='pin_entity'
ORDER BY sequence DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	resolved := make(map[string]bool, len(entityIDs))
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var payload struct {
			EntityID string `json:"entity_id"`
			Pinned   *bool  `json:"pinned"`
		}
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return nil, fmt.Errorf("decode pin_entity curation event: %w", err)
		}
		if !wanted[payload.EntityID] || resolved[payload.EntityID] {
			continue
		}
		// Historical pin events did not carry an explicit boolean; their
		// presence means pinned. New events use pinned=false to unpin.
		result[payload.EntityID] = payload.Pinned == nil || *payload.Pinned
		resolved[payload.EntityID] = true
		if len(resolved) == len(wanted) {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (service *Service) Assertion(ctx context.Context, projectID, assertionID string) (any, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return service.AssertionGeneration(ctx, projectID, head.GenerationID, assertionID)
}

func (service *Service) AssertionGeneration(ctx context.Context, projectID, generationID, assertionID string) (any, error) {
	generation, err := service.DB.KnowledgeGeneration(ctx, projectID, generationID)
	if err != nil {
		return nil, knowledgeLookupError(err)
	}
	if generation.State != store.KnowledgeReady && generation.State != store.KnowledgeRetired {
		return nil, fmt.Errorf("knowledge generation is not readable: %s", generation.State)
	}
	view, err := service.assertion(ctx, projectID, generationID, assertionID)
	if err != nil {
		return nil, err
	}
	return view, nil
}

func (service *Service) assertion(ctx context.Context, projectID, generationID, assertionID string) (AssertionView, error) {
	var view AssertionView
	var literal, qualifiers string
	var object sql.NullString
	var validFrom, validTo sql.NullString
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,valid_from,valid_to,status
FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, assertionID).Scan(&view.ID, &view.SubjectEntityID, &view.PredicateKey, &object, &literal, &qualifiers, &view.Polarity, &validFrom, &validTo, &view.Status); err != nil {
		return AssertionView{}, knowledgeLookupError(err)
	}
	view.ObjectEntityID = object.String
	if literal != "" {
		view.Literal = json.RawMessage(literal)
	}
	view.Qualifiers = json.RawMessage(qualifiers)
	view.ValidFrom = validFrom.String
	view.ValidTo = validTo.String
	evidence, err := service.assertionEvidence(ctx, projectID, generationID, assertionID, "", true)
	if err != nil {
		return AssertionView{}, err
	}
	view.Evidence = evidence
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT i.id,i.rule_axiom_id,p.ordinal,p.premise_assertion_id FROM knowledge_inferences i
JOIN knowledge_inference_proofs p ON p.project_id=i.project_id AND p.generation_id=i.generation_id AND p.inference_id=i.id
WHERE i.project_id=? AND i.generation_id=? AND i.conclusion_assertion_id=? ORDER BY i.id,p.ordinal`, projectID, generationID, assertionID)
	if err != nil {
		return AssertionView{}, err
	}
	for rows.Next() {
		var inferenceID, rule, premise string
		var ordinal int
		if err := rows.Scan(&inferenceID, &rule, &ordinal, &premise); err != nil {
			rows.Close()
			return AssertionView{}, err
		}
		view.Proofs = append(view.Proofs, map[string]any{"inference_id": inferenceID, "rule_id": rule, "ordinal": ordinal, "premise_assertion_id": premise})
	}
	if err := rows.Close(); err != nil {
		return AssertionView{}, err
	}
	conflicts, err := service.DB.SQL().QueryContext(ctx, `SELECT id,left_assertion_id,right_assertion_id,reason,status FROM knowledge_conflicts WHERE project_id=? AND generation_id=? AND (left_assertion_id=? OR right_assertion_id=?) ORDER BY id`, projectID, generationID, assertionID, assertionID)
	if err != nil {
		return AssertionView{}, err
	}
	for conflicts.Next() {
		var id, left, right, reason, status string
		if err := conflicts.Scan(&id, &left, &right, &reason, &status); err != nil {
			conflicts.Close()
			return AssertionView{}, err
		}
		view.Conflicts = append(view.Conflicts, map[string]any{"id": id, "left_assertion_id": left, "right_assertion_id": right, "reason": reason, "status": status})
	}
	return view, conflicts.Close()
}

func (service *Service) assertionEvidence(ctx context.Context, projectID, generationID, assertionID, evidenceID string, withExcerpt bool) ([]EvidenceView, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT evidence_sha256,assertion_id,evidence_kind,blob_hash,COALESCE(chunk_id,''),claim_id,source_id,start_byte,end_byte,locator_json
FROM knowledge_assertion_evidence
WHERE project_id=? AND generation_id=? AND (?='' OR assertion_id=?)
  AND (?='' OR evidence_sha256=?)
ORDER BY assertion_id,evidence_sha256`, projectID, generationID, assertionID, assertionID, evidenceID, evidenceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []EvidenceView
	for rows.Next() {
		var item EvidenceView
		var start, end sql.NullInt64
		var locator string
		if err := rows.Scan(&item.ID, &item.AssertionID, &item.Kind, &item.BlobHash, &item.ChunkID, &item.ClaimID, &item.SourceID, &start, &end, &locator); err != nil {
			return nil, err
		}
		if start.Valid {
			value := int(start.Int64)
			item.StartByte = &value
		}
		if end.Valid {
			value := int(end.Int64)
			item.EndByte = &value
		}
		if locator != "{}" {
			item.Locator = json.RawMessage(locator)
		}
		item.EvidenceHash = item.ID
		if withExcerpt {
			if _, err := service.CAS.ReadVerified(item.BlobHash); err != nil {
				return nil, fmt.Errorf("knowledge evidence CAS readback failed: %w", err)
			}
		}
		if withExcerpt && item.Kind == "text_span" {
			// Knowledge evidence offsets are defined against the immutable chunk
			// text used during extraction, not the enclosing CAS document. Chunks
			// intentionally do not retain document-level byte offsets.
			var text, documentBlobHash, sourceTextHash string
			if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT c.text,d.blob_hash,ks.text_hash FROM chunks c
JOIN documents d ON d.id=c.document_id
JOIN knowledge_sources ks ON ks.chunk_id=c.id AND ks.project_id=d.project_id
WHERE c.id=? AND d.project_id=? AND ks.generation_id=?`, item.ChunkID, projectID, generationID).Scan(&text, &documentBlobHash, &sourceTextHash); err != nil {
				return nil, knowledgeLookupError(err)
			}
			if documentBlobHash != item.BlobHash {
				return nil, errors.New("stored knowledge evidence document does not match its chunk")
			}
			data := []byte(text)
			textSum := sha256.Sum256(data)
			if hex.EncodeToString(textSum[:]) != sourceTextHash {
				return nil, errors.New("stored knowledge evidence chunk hash mismatch")
			}
			if !utf8.Valid(data) || item.StartByte == nil || item.EndByte == nil || *item.StartByte < 0 ||
				*item.EndByte > len(data) || !utf8.RuneStart(data[*item.StartByte]) ||
				(*item.EndByte < len(data) && !utf8.RuneStart(data[*item.EndByte])) {
				return nil, errors.New("stored knowledge evidence byte span is invalid")
			}
			span := data[*item.StartByte:*item.EndByte]
			sum := sha256.Sum256(span)
			if hex.EncodeToString(sum[:]) != item.EvidenceHash {
				return nil, errors.New("stored knowledge evidence hash mismatch")
			}
			item.Excerpt = string(span)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (service *Service) Evidence(ctx context.Context, projectID, evidenceID string) (any, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	items, err := service.assertionEvidence(ctx, projectID, head.GenerationID, "", evidenceID, true)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, store.ErrNotFound
	}
	return map[string]any{"evidence": items}, nil
}

func (service *Service) SPARQL(ctx context.Context, projectID, query string, maxRows int) (any, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return service.SPARQLGeneration(ctx, projectID, head.GenerationID, query, maxRows)
}

func (service *Service) SPARQLGeneration(ctx context.Context, projectID, generationID, query string, maxRows int) (any, error) {
	queryForm, err := ReadOnlySPARQLQueryForm(query)
	if err != nil {
		return nil, err
	}
	if service.Sidecar == nil {
		return nil, errors.New("Oxigraph sidecar is not configured")
	}
	if err := service.DB.VerifyKnowledgeSnapshot(ctx, projectID, generationID, service.CAS); err != nil {
		markErr := service.DB.MarkKnowledgeHeadFailedForGeneration(context.WithoutCancel(ctx), projectID, generationID, err)
		if markErr != nil {
			err = errors.Join(err, fmt.Errorf("mark corrupt knowledge head failed: %w", markErr))
		}
		return nil, err
	}
	var blobHash, datasetHash string
	var tripleCount int
	err = service.DB.SQL().QueryRowContext(ctx, `SELECT blob_hash,dataset_sha256,triple_count FROM knowledge_rdf_snapshots WHERE project_id=? AND generation_id=? AND format='n-quads'`, projectID, generationID).Scan(&blobHash, &datasetHash, &tripleCount)
	if err != nil {
		return nil, err
	}
	snapshot, err := service.CAS.ReadVerified(blobHash)
	if err != nil {
		return nil, err
	}
	if err := service.Sidecar.LoadSnapshot(ctx, projectID, generationID, snapshot, datasetHash, tripleCount); err != nil {
		return nil, err
	}
	result, err := service.Sidecar.Query(ctx, projectID, generationID, query, maxRows)
	if err != nil {
		return nil, err
	}
	return core.SPARQLResult{QueryForm: queryForm, Complete: true, Result: result}, nil
}

func (service *Service) Materials(ctx context.Context, projectID string) (any, error) {
	return service.DB.PinnedMaterials(ctx, projectID)
}
func (service *Service) PinMaterial(ctx context.Context, projectID, title, mediaType string, data []byte, graphAdopt bool) (any, error) {
	if service.Memory == nil {
		return nil, errors.New("memory service is not configured")
	}
	return service.Memory.PinMaterial(ctx, projectID, title, mediaType, data, graphAdopt)
}
func (service *Service) SetMaterialGraphAdopt(ctx context.Context, projectID, documentID string, enabled bool) (any, error) {
	return service.DB.UpdatePinnedMaterialGraphAdopt(ctx, projectID, documentID, enabled)
}
func (service *Service) DeleteMaterial(ctx context.Context, projectID, documentID, confirmationTitle string) (any, error) {
	result, err := service.DB.ForgetMemoryDocument(ctx, projectID, documentID, confirmationTitle)
	if err != nil {
		return nil, err
	}
	// CAS reclamation is startup-only. Online deletion races with a concurrent
	// same-hash adoption after the SQLite orphan decision has committed.
	removed := false
	cleanupPending := result.OrphanedBlobHash != ""
	return map[string]any{
		"deleted": result.Deleted, "forgotten": result.Forgotten,
		"retained_for_graph_provenance": result.RetainedForGraphProvenance,
		"knowledge_graph_stale":         result.KnowledgeGraphStale,
		"cas_object_removed":            removed,
		"cas_cleanup_pending":           cleanupPending,
	}, nil
}

func entityIRI(projectID, entityID string) string {
	return "urn:aetherops:project:" + base64.RawURLEncoding.EncodeToString([]byte(projectID)) + ":entity:" + url.PathEscape(entityID)
}
func assertionIRI(projectID, assertionID string) string {
	return "urn:aetherops:project:" + base64.RawURLEncoding.EncodeToString([]byte(projectID)) + ":assertion:" + url.PathEscape(assertionID)
}

func (service *Service) ExportJSONLD(ctx context.Context, projectID string) ([]byte, error) {
	head, err := service.readyHead(ctx, projectID)
	if err != nil {
		return nil, err
	}
	terms := map[string]string{}
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT term_key,iri FROM ontology_terms WHERE ontology_id=? OR ontology_id=?`, head.Generation.OntologyID, store.CoreOntologyID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key, iri string
		if err := rows.Scan(&key, &iri); err != nil {
			rows.Close()
			return nil, err
		}
		terms[key] = iri
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	graph := []any{}
	inferredTypeIRIs := map[string][]string{}
	typeRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT entity_id,class_key FROM knowledge_type_inferences
WHERE project_id=? AND generation_id=? AND status='accepted'
ORDER BY entity_id,class_key`, projectID, head.GenerationID)
	if err != nil {
		return nil, err
	}
	for typeRows.Next() {
		var entityID, classKey string
		if err := typeRows.Scan(&entityID, &classKey); err != nil {
			typeRows.Close()
			return nil, err
		}
		if iri := terms[classKey]; iri != "" {
			inferredTypeIRIs[entityID] = append(inferredTypeIRIs[entityID], iri)
		}
	}
	if err := typeRows.Close(); err != nil {
		return nil, err
	}
	entities, err := service.DB.SQL().QueryContext(ctx, `SELECT id,class_key,canonical_name,description FROM knowledge_entities WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, head.GenerationID)
	if err != nil {
		return nil, err
	}
	for entities.Next() {
		var id, classKey, name, description string
		if err := entities.Scan(&id, &classKey, &name, &description); err != nil {
			entities.Close()
			return nil, err
		}
		types := []string{terms[classKey]}
		types = append(types, inferredTypeIRIs[id]...)
		graph = append(graph, map[string]any{"@id": entityIRI(projectID, id), "@type": types, "http://www.w3.org/2000/01/rdf-schema#label": name, "urn:aetherops:description": description})
	}
	if err := entities.Close(); err != nil {
		return nil, err
	}
	assertions, err := service.DB.SQL().QueryContext(ctx, `SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),literal_json,qualifiers_json,polarity,valid_from,valid_to,status FROM knowledge_assertions WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, head.GenerationID)
	if err != nil {
		return nil, err
	}
	for assertions.Next() {
		var id, subject, predicate, object, literal, qualifiers, polarity, status string
		var from, to sql.NullString
		if err := assertions.Scan(&id, &subject, &predicate, &object, &literal, &qualifiers, &polarity, &from, &to, &status); err != nil {
			assertions.Close()
			return nil, err
		}
		node := map[string]any{"@id": assertionIRI(projectID, id), "@type": "urn:aetherops:Assertion", "http://www.w3.org/1999/02/22-rdf-syntax-ns#subject": map[string]any{"@id": entityIRI(projectID, subject)}, "http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate": map[string]any{"@id": terms[predicate]}, "urn:aetherops:qualifiers": json.RawMessage(qualifiers), "urn:aetherops:polarity": polarity, "urn:aetherops:status": status}
		if object != "" {
			node["http://www.w3.org/1999/02/22-rdf-syntax-ns#object"] = map[string]any{"@id": entityIRI(projectID, object)}
		} else if literal != "" {
			node["http://www.w3.org/1999/02/22-rdf-syntax-ns#object"] = json.RawMessage(literal)
		}
		if from.Valid {
			node["urn:aetherops:validFrom"] = from.String
		}
		if to.Valid {
			node["urn:aetherops:validTo"] = to.String
		}
		graph = append(graph, node)
	}
	if err := assertions.Close(); err != nil {
		return nil, err
	}
	return json.MarshalIndent(map[string]any{"@context": map[string]any{"aether": "urn:aetherops:", "rdf": rdfNS, "rdfs": rdfsNS, "owl": owlNS}, "@graph": graph}, "", "  ")
}

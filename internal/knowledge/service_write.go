package knowledge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
	"github.com/djkim0320/AetherOps/internal/rag"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	knowledgeMaterializationContract = "aetherops-knowledge-materialization-v1"
	curationValidationContract       = "aetherops-curation-validation-v1"
)

type ontologyTermRow struct {
	Key, IRI, Kind, Label, Description, Domain, Range, ValueKind string
	Functional, Temporal, Expandable                             bool
}

type ontologyAxiomRow struct {
	ID, Type, Subject, Predicate, Object string
	Literal                              json.RawMessage
}

// ImportOntology accepts only the documented local RDF schema subset. Both
// source bytes and the deterministic canonical N-Quads representation are
// committed to CAS before the draft schema becomes visible.
func (service *Service) ImportOntology(ctx context.Context, projectID, name, format string, data []byte) (any, error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	parsed, err := ParseOntology(name, format, data)
	if err != nil {
		return nil, err
	}
	terms, axioms, err := ontologyRows(parsed.Triples)
	if err != nil {
		return nil, err
	}
	for _, term := range terms {
		var importedIRI string
		err := service.DB.SQL().QueryRowContext(ctx, `
SELECT iri FROM ontology_terms WHERE ontology_id=? AND term_key=?`, store.CoreOntologyID, term.Key).Scan(&importedIRI)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err == nil && importedIRI != term.IRI {
			return nil, fmt.Errorf("ontology term key %q collides with imported core IRI %s", term.Key, importedIRI)
		}
	}
	sourceReceipt, err := service.CAS.PutBytes(data)
	if err != nil {
		return nil, err
	}
	if _, err := service.CAS.ReadVerified(sourceReceipt.Hash); err != nil {
		return nil, err
	}
	if err := service.DB.RegisterBlob(ctx, sourceReceipt, ontologyMediaType(parsed.Format)); err != nil {
		return nil, err
	}
	canonicalReceipt, err := service.CAS.PutBytes(parsed.CanonicalNQuads)
	if err != nil {
		return nil, err
	}
	if _, err := service.CAS.ReadVerified(canonicalReceipt.Hash); err != nil {
		return nil, err
	}
	canonicalMediaType := "application/n-quads"
	if canonicalReceipt.Hash == sourceReceipt.Hash {
		canonicalMediaType = ontologyMediaType(parsed.Format)
	}
	if err := service.DB.RegisterBlob(ctx, canonicalReceipt, canonicalMediaType); err != nil {
		return nil, err
	}
	ontologyID, err := id.New("ont")
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	semanticVersion := "project-" + parsed.SHA256[:12]
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var projectExists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM projects WHERE id=?`, projectID).Scan(&projectExists); err != nil {
		return nil, err
	}
	if projectExists != 1 {
		return nil, store.ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO ontology_versions(
 id,project_id,semantic_version,source_blob_hash,canonical_blob_hash,
 canonical_sha256,triple_count,state,created_at,activated_at,retired_at
) VALUES(?,?,?,?,?,?,?,'draft',?,NULL,NULL)`, ontologyID, projectID, semanticVersion,
		sourceReceipt.Hash, canonicalReceipt.Hash, parsed.SHA256, parsed.TripleCount, now); err != nil {
		return nil, err
	}
	for _, term := range terms {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO ontology_terms(
 ontology_id,term_key,iri,kind,label,description,domain_key,range_key,value_kind,
 functional,temporal,expandable,created_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ontologyID, term.Key, term.IRI, term.Kind, term.Label,
			term.Description, term.Domain, term.Range, term.ValueKind, boolInt(term.Functional),
			boolInt(term.Temporal), boolInt(term.Expandable), now); err != nil {
			return nil, fmt.Errorf("insert ontology term %s: %w", term.Key, err)
		}
	}
	for _, axiom := range axioms {
		literal := ""
		if len(axiom.Literal) != 0 {
			literal = string(axiom.Literal)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO ontology_axioms(
 ontology_id,id,axiom_type,subject_key,predicate_key,object_key,literal_json,created_at
) VALUES(?,?,?,?,?,?,?,?)`, ontologyID, axiom.ID, axiom.Type, axiom.Subject,
			axiom.Predicate, axiom.Object, literal, now); err != nil {
			return nil, fmt.Errorf("insert ontology axiom %s: %w", axiom.ID, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO ontology_imports(ontology_id,imported_ontology_id,required,created_at)
VALUES(?,?,1,?)`, ontologyID, store.CoreOntologyID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{
		"ontology_version_id": ontologyID, "version_id": ontologyID,
		"semantic_version": semanticVersion, "state": "draft", "format": parsed.Format,
		"canonical_sha256": parsed.SHA256, "triple_count": parsed.TripleCount,
		"term_count": len(terms), "axiom_count": len(axioms),
	}, nil
}

func ontologyMediaType(format string) string {
	switch format {
	case "turtle":
		return "text/turtle"
	case "jsonld":
		return "application/ld+json"
	default:
		return "application/rdf+xml"
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func ontologyRows(triples []RDFTriple) ([]ontologyTermRow, []ontologyAxiomRow, error) {
	type draft struct {
		IRI, Kind, Label, Description, DomainIRI, RangeIRI, ValueKind string
		LabelOrder, DescriptionOrder                                  string
		Functional, Temporal, Expandable                              bool
	}
	drafts := map[string]*draft{}
	ensure := func(iri string) *draft {
		value := drafts[iri]
		if value == nil {
			value = &draft{IRI: iri, Label: iriLocalName(iri)}
			drafts[iri] = value
		}
		return value
	}
	setKind := func(iri, kind string) (*draft, error) {
		value := ensure(iri)
		if value.Kind != "" && value.Kind != kind {
			return nil, fmt.Errorf("ontology term %s has conflicting kinds %s and %s", iri, value.Kind, kind)
		}
		value.Kind = kind
		return value, nil
	}
	propertyReferences := map[string]bool{}
	for _, triple := range triples {
		switch triple.Predicate {
		case rdfNS + "type":
			switch triple.Object.IRI {
			case rdfsNS + "Class", owlNS + "Class":
				if _, err := setKind(triple.Subject, "class"); err != nil {
					return nil, nil, err
				}
			case owlNS + "DatatypeProperty":
				value, err := setKind(triple.Subject, "datatype_property")
				if err != nil {
					return nil, nil, err
				}
				if value.ValueKind == "" {
					value.ValueKind = "string"
				}
				propertyReferences[triple.Subject] = true
			case owlNS + "AnnotationProperty":
				if _, err := setKind(triple.Subject, "annotation_property"); err != nil {
					return nil, nil, err
				}
				propertyReferences[triple.Subject] = true
			case rdfNS + "Property":
				ensure(triple.Subject)
				propertyReferences[triple.Subject] = true
			case owlNS + "ObjectProperty":
				value, err := setKind(triple.Subject, "object_property")
				if err != nil {
					return nil, nil, err
				}
				value.ValueKind, value.Expandable = "entity", true
				propertyReferences[triple.Subject] = true
			case owlNS + "SymmetricProperty", owlNS + "TransitiveProperty":
				value, err := setKind(triple.Subject, "object_property")
				if err != nil {
					return nil, nil, err
				}
				value.ValueKind, value.Expandable = "entity", true
				propertyReferences[triple.Subject] = true
			case owlNS + "FunctionalProperty":
				ensure(triple.Subject).Functional = true
				propertyReferences[triple.Subject] = true
			case owlNS + "Ontology":
				// The ontology resource is metadata, not an instance term.
			}
		case rdfsNS + "subClassOf":
			if _, err := setKind(triple.Subject, "class"); err != nil {
				return nil, nil, err
			}
			if _, err := setKind(triple.Object.IRI, "class"); err != nil {
				return nil, nil, err
			}
		case rdfsNS + "subPropertyOf":
			ensure(triple.Subject)
			ensure(triple.Object.IRI)
			propertyReferences[triple.Subject], propertyReferences[triple.Object.IRI] = true, true
		case owlNS + "inverseOf":
			left, err := setKind(triple.Subject, "object_property")
			if err != nil {
				return nil, nil, err
			}
			right, err := setKind(triple.Object.IRI, "object_property")
			if err != nil {
				return nil, nil, err
			}
			left.ValueKind, right.ValueKind = "entity", "entity"
			left.Expandable, right.Expandable = true, true
			propertyReferences[triple.Subject], propertyReferences[triple.Object.IRI] = true, true
		case rdfsNS + "domain":
			property := ensure(triple.Subject)
			if property.DomainIRI != "" && property.DomainIRI != triple.Object.IRI {
				return nil, nil, fmt.Errorf("ontology property %s has multiple unsupported domains %s and %s", triple.Subject, property.DomainIRI, triple.Object.IRI)
			}
			property.DomainIRI = triple.Object.IRI
			propertyReferences[triple.Subject] = true
			if _, err := setKind(triple.Object.IRI, "class"); err != nil {
				return nil, nil, err
			}
		case rdfsNS + "range":
			property := ensure(triple.Subject)
			propertyReferences[triple.Subject] = true
			if property.RangeIRI != "" && property.RangeIRI != triple.Object.IRI {
				return nil, nil, fmt.Errorf("ontology property %s has multiple unsupported ranges %s and %s", triple.Subject, property.RangeIRI, triple.Object.IRI)
			}
			property.RangeIRI = triple.Object.IRI
			if strings.HasPrefix(triple.Object.IRI, xsdNS) {
				var err error
				property, err = setKind(triple.Subject, "datatype_property")
				if err != nil {
					return nil, nil, err
				}
				property.ValueKind = xsdValueKind(triple.Object.IRI)
			} else {
				var err error
				property, err = setKind(triple.Subject, "object_property")
				if err != nil {
					return nil, nil, err
				}
				property.ValueKind = "entity"
				if _, err := setKind(triple.Object.IRI, "class"); err != nil {
					return nil, nil, err
				}
			}
		case rdfsNS + "label":
			value := ensure(triple.Subject)
			order := triple.Object.Language + "\x00" + triple.Object.Datatype + "\x00" + triple.Object.Value
			if value.LabelOrder == "" || order < value.LabelOrder {
				value.Label, value.LabelOrder = triple.Object.Value, order
			}
		case rdfsNS + "comment":
			value := ensure(triple.Subject)
			order := triple.Object.Language + "\x00" + triple.Object.Datatype + "\x00" + triple.Object.Value
			if value.DescriptionOrder == "" || order < value.DescriptionOrder {
				value.Description, value.DescriptionOrder = triple.Object.Value, order
			}
		}
	}
	for iri, value := range drafts {
		if value.Kind == "" {
			return nil, nil, fmt.Errorf("ontology term %s has no supported class/property declaration", iri)
		}
		if propertyReferences[iri] && value.Kind == "class" {
			return nil, nil, fmt.Errorf("ontology term %s is used as both a class and a property", iri)
		}
		if value.Functional && value.Kind != "object_property" && value.Kind != "datatype_property" {
			return nil, nil, fmt.Errorf("ontology term %s uses FunctionalProperty with unsupported kind %s", iri, value.Kind)
		}
	}
	iris := make([]string, 0, len(drafts))
	for iri := range drafts {
		iris = append(iris, iri)
	}
	sort.Strings(iris)
	keys := make(map[string]string, len(iris))
	used := map[string]bool{}
	for _, iri := range iris {
		key := ontologyTermKey(iri)
		if used[key] {
			sum := sha256.Sum256([]byte(iri))
			key += "_" + hex.EncodeToString(sum[:4])
		}
		used[key], keys[iri] = true, key
	}
	terms := make([]ontologyTermRow, 0, len(iris))
	for _, iri := range iris {
		value := drafts[iri]
		terms = append(terms, ontologyTermRow{Key: keys[iri], IRI: iri, Kind: value.Kind,
			Label: value.Label, Description: value.Description, Domain: keys[value.DomainIRI], Range: keys[value.RangeIRI],
			ValueKind: value.ValueKind, Functional: value.Functional, Temporal: value.Temporal, Expandable: value.Expandable})
	}
	axioms := make([]ontologyAxiomRow, 0, len(triples))
	for _, triple := range triples {
		row := ontologyAxiomRow{Subject: keys[triple.Subject]}
		switch triple.Predicate {
		case rdfsNS + "subClassOf":
			row.Type, row.Object = "subclass_of", keys[triple.Object.IRI]
		case rdfsNS + "subPropertyOf":
			row.Type, row.Object = "subproperty_of", keys[triple.Object.IRI]
		case rdfsNS + "domain":
			row.Type, row.Object = "domain", keys[triple.Object.IRI]
		case rdfsNS + "range":
			row.Type, row.Object = "range", keys[triple.Object.IRI]
			if row.Object == "" {
				row.Object = triple.Object.IRI
			}
		case owlNS + "inverseOf":
			row.Type, row.Object = "inverse_of", keys[triple.Object.IRI]
		case rdfNS + "type":
			switch triple.Object.IRI {
			case owlNS + "SymmetricProperty":
				row.Type = "symmetric"
			case owlNS + "TransitiveProperty":
				row.Type = "transitive"
			case owlNS + "FunctionalProperty":
				row.Type = "functional"
			}
		case rdfsNS + "label", rdfsNS + "comment":
			row.Type, row.Predicate = "annotation", triple.Predicate
			row.Literal, _ = json.Marshal(map[string]any{"value": triple.Object.Value, "language": triple.Object.Language, "datatype": triple.Object.Datatype})
		}
		if row.Type == "" || row.Subject == "" {
			continue
		}
		material, _ := json.Marshal([]any{row.Type, row.Subject, row.Predicate, row.Object, row.Literal})
		sum := sha256.Sum256(material)
		row.ID = "oax_" + hex.EncodeToString(sum[:12])
		axioms = append(axioms, row)
	}
	sort.Slice(axioms, func(i, j int) bool { return axioms[i].ID < axioms[j].ID })
	return terms, axioms, nil
}

func ontologyTermKey(iri string) string {
	name := strings.ToLower(iriLocalName(iri))
	var builder strings.Builder
	for _, value := range name {
		if unicode.IsLetter(value) || unicode.IsDigit(value) {
			builder.WriteRune(value)
		} else if builder.Len() > 0 && !strings.HasSuffix(builder.String(), "_") {
			builder.WriteByte('_')
		}
	}
	key := strings.Trim(builder.String(), "_")
	if key == "" {
		sum := sha256.Sum256([]byte(iri))
		key = "term_" + hex.EncodeToString(sum[:6])
	}
	return key
}

func iriLocalName(iri string) string {
	trimmed := strings.TrimRight(iri, "#/")
	if index := strings.LastIndexAny(trimmed, "#/"); index >= 0 && index+1 < len(trimmed) {
		return trimmed[index+1:]
	}
	return trimmed
}

func xsdValueKind(iri string) string {
	switch strings.TrimPrefix(iri, xsdNS) {
	case "boolean":
		return "boolean"
	case "date", "dateTime", "time":
		return "time"
	case "decimal", "double", "float", "integer", "int", "long", "short", "nonNegativeInteger", "positiveInteger":
		return "number"
	default:
		return "string"
	}
}

func (service *Service) ActivateOntology(ctx context.Context, projectID, ontologyID string) (any, error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	release, err := service.acquireKnowledgeMutation(projectID, "ontology activation")
	if err != nil {
		return nil, err
	}
	defer release()
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var state string
	if err := tx.QueryRowContext(ctx, `SELECT state FROM ontology_versions WHERE id=? AND project_id=?`, ontologyID, projectID).Scan(&state); err != nil {
		return nil, err
	}
	if state != "draft" {
		return nil, errors.New("only a project draft ontology can be activated")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `UPDATE ontology_versions SET state='retired',retired_at=? WHERE project_id=? AND state='active'`, now, projectID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ontology_versions SET state='active',activated_at=? WHERE id=? AND project_id=? AND state='draft'`, now, ontologyID, projectID); err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE project_knowledge_heads SET status='stale',error='ontology changed; verified shadow rebuild required',
 knowledge_revision=knowledge_revision+1,updated_at=? WHERE project_id=?`, now, projectID)
	if err != nil {
		return nil, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err == nil {
			err = store.ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"ontology_version_id": ontologyID, "state": "active", "knowledge_state": "stale"}, nil
}

type editEnvelope struct {
	Patch json.RawMessage `json:"patch"`
}

type editMetadata struct {
	Kind        string            `json:"kind"`
	EvidenceIDs []string          `json:"evidence_ids"`
	Memo        string            `json:"memo"`
	Operations  []json.RawMessage `json:"operations"`
}

type curationMemoChunk struct {
	ChunkID    string `json:"chunk_id"`
	StartByte  int    `json:"start_byte"`
	EndByte    int    `json:"end_byte"`
	SpanSHA256 string `json:"span_sha256"`
}

type curationMemoBinding struct {
	MemoBlobHash   string              `json:"memo_blob_hash"`
	MemoDocumentID string              `json:"memo_document_id"`
	MemoStartByte  int                 `json:"memo_start_byte"`
	MemoEndByte    int                 `json:"memo_end_byte"`
	MemoSpanSHA256 string              `json:"memo_span_sha256"`
	MemoChunks     []curationMemoChunk `json:"memo_chunks"`
}

var reservedCurationMemoFields = []string{
	"memo_blob_hash", "memo_document_id", "memo_start_byte", "memo_end_byte", "memo_span_sha256", "memo_chunks",
}

func (service *Service) ApplyEdit(ctx context.Context, projectID string, raw json.RawMessage) (any, error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	release, err := service.acquireKnowledgeMutation(projectID, "knowledge edit validation")
	if err != nil {
		return nil, err
	}
	defer release()
	var envelope editEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	patch := envelope.Patch
	if len(patch) == 0 {
		patch = raw
	}
	var metadata editMetadata
	if err := json.Unmarshal(patch, &metadata); err != nil {
		return nil, errors.New("knowledge edit patch must be a JSON object")
	}
	if metadata.Kind == "" && len(metadata.Operations) == 1 {
		var operation map[string]any
		if err := json.Unmarshal(metadata.Operations[0], &operation); err != nil {
			return nil, err
		}
		metadata.Kind, _ = operation["kind"].(string)
		if metadata.Kind == "" {
			metadata.Kind, _ = operation["op"].(string)
		}
		operation["kind"] = normalizeCurationKind(metadata.Kind)
		operation["evidence_ids"] = metadata.EvidenceIDs
		operation["memo"] = metadata.Memo
		patch, _ = json.Marshal(operation)
		metadata.Kind = normalizeCurationKind(metadata.Kind)
	} else {
		metadata.Kind = normalizeCurationKind(metadata.Kind)
	}
	var patchObject map[string]any
	if err := json.Unmarshal(patch, &patchObject); err != nil || patchObject == nil {
		return nil, errors.New("knowledge edit patch must be a JSON object")
	}
	for _, field := range reservedCurationMemoFields {
		if _, exists := patchObject[field]; exists {
			return nil, fmt.Errorf("knowledge edit field %q is reserved for a server-verified CAS memo binding", field)
		}
	}
	if !supportedCurationKind(metadata.Kind) {
		return nil, fmt.Errorf("unsupported knowledge edit kind %q", metadata.Kind)
	}
	if len(metadata.EvidenceIDs) == 0 && strings.TrimSpace(metadata.Memo) == "" {
		return nil, errors.New("knowledge edits require existing evidence_ids or a new pinned memo")
	}
	head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for _, evidenceID := range metadata.EvidenceIDs {
		var count int
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT COUNT(*) FROM knowledge_assertion_evidence
WHERE project_id=? AND generation_id=? AND evidence_sha256=?`, projectID, head.GenerationID, evidenceID).Scan(&count); err != nil {
			return nil, err
		}
		if count == 0 {
			return nil, fmt.Errorf("evidence handle %s is not in the active project generation", evidenceID)
		}
	}
	if strings.TrimSpace(metadata.Memo) == "" {
		delete(patchObject, "memo")
		patch, _ = json.Marshal(patchObject)
	} else {
		if len([]byte(metadata.Memo)) > 64<<10 {
			return nil, errors.New("curation memo is limited to 64 KiB")
		}
		binding, err := service.pinCurationMemo(ctx, projectID, metadata.Memo)
		if err != nil {
			return nil, fmt.Errorf("pin curation memo: %w", err)
		}
		delete(patchObject, "memo")
		encoded, _ := json.Marshal(binding)
		var fields map[string]any
		_ = json.Unmarshal(encoded, &fields)
		for key, value := range fields {
			patchObject[key] = value
		}
		patch, _ = json.Marshal(patchObject)
	}
	if err := service.validateCurationPatch(ctx, projectID, head, metadata.Kind, patch); err != nil {
		return nil, fmt.Errorf("knowledge edit validation failed before ledger append: %w", err)
	}
	event, err := service.DB.AppendKnowledgeCuration(ctx, projectID, head.GenerationID, metadata.Kind, "user", patch)
	if err != nil {
		return nil, err
	}
	updated, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if updated.Status != store.KnowledgeHeadStale {
		updated, err = service.DB.SetKnowledgeHeadStatus(ctx, projectID, updated.KnowledgeRevision, store.KnowledgeHeadStale, "curation pending verified shadow rebuild")
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"event": event, "knowledge_head": updated}, nil
}

func (service *Service) pinCurationMemo(ctx context.Context, projectID, memo string) (curationMemoBinding, error) {
	data := []byte(memo)
	if strings.TrimSpace(memo) == "" || !utf8.Valid(data) {
		return curationMemoBinding{}, errors.New("curation memo must contain valid non-whitespace UTF-8 text")
	}
	receipt, err := service.CAS.PutBytes(data)
	if err != nil {
		return curationMemoBinding{}, err
	}
	readback, err := service.CAS.ReadVerified(receipt.Hash)
	if err != nil {
		return curationMemoBinding{}, err
	}
	if !bytes.Equal(readback, data) {
		return curationMemoBinding{}, errors.New("curation memo CAS readback differs from submitted bytes")
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "text/plain; charset=utf-8"); err != nil {
		return curationMemoBinding{}, err
	}
	if service.Memory == nil {
		return curationMemoBinding{}, errors.New("memory indexer is required to pin a curation memo")
	}
	expected := rag.ChunkText(memo, rag.DefaultChunkRunes, rag.DefaultOverlapRunes)
	if len(expected) == 0 {
		return curationMemoBinding{}, errors.New("curation memo contains no deterministic chunks")
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id FROM documents
WHERE project_id=? AND blob_hash=? AND COALESCE(artifact_id,'')='' AND status='ready' AND pinned=1
ORDER BY id`, projectID, receipt.Hash)
	if err != nil {
		return curationMemoBinding{}, err
	}
	var documentIDs []string
	for rows.Next() {
		var documentID string
		if err := rows.Scan(&documentID); err != nil {
			rows.Close()
			return curationMemoBinding{}, err
		}
		documentIDs = append(documentIDs, documentID)
	}
	if err := rows.Close(); err != nil {
		return curationMemoBinding{}, err
	}
	if len(documentIDs) > 1 {
		return curationMemoBinding{}, errors.New("multiple pinned documents already reference the curation memo CAS blob")
	}
	documentID := ""
	if len(documentIDs) == 1 {
		documentID = documentIDs[0]
	} else {
		document, err := service.Memory.PinMaterial(ctx, projectID, "Curation memo "+receipt.Hash[:12], "text/plain; charset=utf-8", data, false)
		if err != nil {
			return curationMemoBinding{}, err
		}
		documentID = document.ID
	}
	if err := service.DB.MarkCurationMemoDocument(ctx, projectID, documentID, receipt.Hash); err != nil {
		return curationMemoBinding{}, err
	}
	if err := service.DB.VerifyDocumentIndex(ctx, projectID, "", receipt.Hash, expected); err != nil {
		return curationMemoBinding{}, fmt.Errorf("verify pinned curation memo index: %w", err)
	}
	chunkRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,ordinal,text,text_hash FROM chunks WHERE document_id=? ORDER BY ordinal,id`, documentID)
	if err != nil {
		return curationMemoBinding{}, err
	}
	var chunks []curationMemoChunk
	for chunkRows.Next() {
		var chunk curationMemoChunk
		var ordinal int
		var text, textHash string
		if err := chunkRows.Scan(&chunk.ChunkID, &ordinal, &text, &textHash); err != nil {
			chunkRows.Close()
			return curationMemoBinding{}, err
		}
		if ordinal != len(chunks) || ordinal >= len(expected) || expected[ordinal].Ordinal != ordinal || expected[ordinal].Text != text {
			chunkRows.Close()
			return curationMemoBinding{}, errors.New("pinned curation memo chunks are not deterministic")
		}
		chunk.StartByte, chunk.EndByte, chunk.SpanSHA256 = 0, len([]byte(text)), textHash
		chunks = append(chunks, chunk)
	}
	if err := chunkRows.Close(); err != nil {
		return curationMemoBinding{}, err
	}
	if len(chunks) != len(expected) {
		return curationMemoBinding{}, errors.New("pinned curation memo chunk count changed after verification")
	}
	return curationMemoBinding{
		MemoBlobHash: receipt.Hash, MemoDocumentID: documentID,
		MemoStartByte: 0, MemoEndByte: len(data), MemoSpanSHA256: receipt.Hash, MemoChunks: chunks,
	}, nil
}

func normalizeCurationKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "create_entity":
		return "add_entity"
	case "create_relation", "create_assertion":
		return "add_assertion"
	case "merge":
		return "merge_entities"
	case "split":
		return "split_entity"
	case "retract":
		return "retract_assertion"
	case "restore":
		return "restore_assertion"
	default:
		return strings.ToLower(strings.TrimSpace(kind))
	}
}

func supportedCurationKind(kind string) bool {
	switch kind {
	case "add_entity", "add_assertion", "update_assertion", "merge_entities", "split_entity",
		"retract_assertion", "restore_assertion", "add_alias", "pin_entity", "resolve_conflict", "dismiss_conflict":
		return true
	default:
		return false
	}
}

// acquireKnowledgeMutation serializes projection-changing work per project.
// The critical section spans preflight and ledger append, preventing a rebuild
// from swapping the active head between those two operations. Different
// projects still validate and rebuild concurrently.
func (service *Service) acquireKnowledgeMutation(projectID, operation string) (func(), error) {
	service.rebuildMu.Lock()
	defer service.rebuildMu.Unlock()
	if service.rebuilding == nil {
		service.rebuilding = map[string]bool{}
	}
	if service.rebuilding[projectID] {
		return nil, fmt.Errorf("knowledge mutation is already running for this project; cannot start %s", operation)
	}
	service.rebuilding[projectID] = true
	return func() {
		service.rebuildMu.Lock()
		delete(service.rebuilding, projectID)
		service.rebuildMu.Unlock()
	}, nil
}

func curationValidationContractSHA256() string {
	sum := sha256.Sum256([]byte(curationValidationContract))
	return hex.EncodeToString(sum[:])
}

// validateCurationPatch replays the complete pending ledger plus the proposed
// event into a disposable building generation. No append-only curation row is
// written until the same deterministic materializer used by Rebuild succeeds.
func (service *Service) validateCurationPatch(
	ctx context.Context,
	projectID string,
	head store.KnowledgeHead,
	kind string,
	payload json.RawMessage,
) (returnErr error) {
	candidate, err := service.DB.CreateKnowledgeGeneration(
		ctx, projectID, head.Generation.OntologyID, curationValidationContractSHA256(),
	)
	if err != nil {
		return err
	}
	defer func() {
		cleanupCtx := context.WithoutCancel(ctx)
		if err := service.DB.DeleteBuildingKnowledgeGeneration(
			cleanupCtx, projectID, candidate.ID, curationValidationContractSHA256(),
		); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove curation validation generation: %w", err))
		}
	}()
	if err := service.copyActiveProjection(ctx, projectID, head.Generation, candidate); err != nil {
		return err
	}
	conflictEvents, err := service.applyPendingCuration(ctx, projectID, head.GenerationID, candidate.ID)
	if err != nil {
		return err
	}
	proposedConflict := kind == "resolve_conflict" || kind == "dismiss_conflict"
	if proposedConflict {
		conflictEvents = append(conflictEvents, pendingKnowledgeCuration{Kind: kind, Payload: payload})
	} else if err := service.applyCurationEvent(ctx, projectID, candidate.ID, kind, payload); err != nil {
		return err
	}
	if err := service.rekeyKnowledgeAssertions(ctx, projectID, candidate.ID); err != nil {
		return err
	}
	if err := service.materializeOntologyProjection(ctx, projectID, candidate.ID); err != nil {
		return err
	}
	for _, event := range conflictEvents {
		if err := service.applyCurationEvent(ctx, projectID, candidate.ID, event.Kind, event.Payload); err != nil {
			return fmt.Errorf("apply conflict curation %s: %w", event.Kind, err)
		}
	}
	if err := service.validateCurationCandidate(ctx, projectID, candidate.ID, candidate.OntologyID); err != nil {
		return err
	}
	if _, _, err := service.generationNQuads(ctx, projectID, candidate.ID, candidate.OntologyID); err != nil {
		return fmt.Errorf("serialize curation validation graph: %w", err)
	}
	return nil
}

func (service *Service) Rebuild(ctx context.Context, projectID string) (result any, returnErr error) {
	if err := service.configured(); err != nil {
		return nil, err
	}
	if service.Sidecar == nil {
		return nil, errors.New("Oxigraph sidecar is required to validate a knowledge generation")
	}
	release, err := service.acquireKnowledgeMutation(projectID, "knowledge rebuild")
	if err != nil {
		return nil, err
	}
	defer release()
	head, err := service.DB.ActiveKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if recovered, ok, err := service.recoverSnapshotCompletePinnedCandidate(ctx, projectID); err != nil {
		return nil, err
	} else if ok {
		return recovered, nil
	}
	if err := service.quarantineIncompletePinnedCandidates(ctx, projectID); err != nil {
		return nil, err
	}
	ontologyID := store.CoreOntologyID
	var ontologyHash string
	err = service.DB.SQL().QueryRowContext(ctx, `
SELECT id,canonical_sha256 FROM ontology_versions
WHERE project_id=? AND state='active' ORDER BY activated_at DESC LIMIT 1`, projectID).Scan(&ontologyID, &ontologyHash)
	if errors.Is(err, sql.ErrNoRows) {
		err = service.DB.SQL().QueryRowContext(ctx, `SELECT canonical_sha256 FROM ontology_versions WHERE id=? AND state='active'`, store.CoreOntologyID).Scan(&ontologyHash)
	}
	if err != nil {
		return nil, err
	}
	contractSum := sha256.Sum256([]byte(knowledgeMaterializationContract + "\n" + ontologyHash))
	materializationContract := hex.EncodeToString(contractSum[:])
	if err := service.quarantineIncompleteRebuildCandidates(ctx, projectID, materializationContract); err != nil {
		return nil, err
	}
	candidate, err := service.DB.CreateKnowledgeGeneration(ctx, projectID, ontologyID, materializationContract)
	if err != nil {
		return nil, err
	}
	state := store.KnowledgeBuilding
	defer func() {
		if returnErr == nil || (state != store.KnowledgeBuilding && state != store.KnowledgeValidating) {
			return
		}
		failureCtx := context.WithoutCancel(ctx)
		if state == store.KnowledgeBuilding {
			if batchErr := service.failOpenExtractionBatches(failureCtx, projectID, candidate.ID, returnErr); batchErr != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("close knowledge extraction batches: %w", batchErr))
			}
		}
		_, markErr := service.DB.TransitionKnowledgeGeneration(failureCtx, projectID, candidate.ID, state, store.KnowledgeFailed, returnErr.Error())
		if markErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("mark knowledge candidate failed: %w", markErr))
		}
	}()
	if err := service.copyActiveProjection(ctx, projectID, head.Generation, candidate); err != nil {
		return nil, err
	}
	pendingConflictCuration, err := service.applyPendingCuration(ctx, projectID, head.GenerationID, candidate.ID)
	if err != nil {
		return nil, err
	}
	service.checkpointDurabilityTest("rebuild_after_curation_apply")
	if err := service.projectPinnedDocuments(ctx, projectID, head.GenerationID, candidate); err != nil {
		return nil, err
	}
	if err := service.rekeyKnowledgeAssertions(ctx, projectID, candidate.ID); err != nil {
		return nil, err
	}
	if err := service.materializeOntologyProjection(ctx, projectID, candidate.ID); err != nil {
		return nil, err
	}
	service.checkpointDurabilityTest("rebuild_after_inference")
	for _, event := range pendingConflictCuration {
		if err := service.applyCurationEvent(ctx, projectID, candidate.ID, event.Kind, event.Payload); err != nil {
			return nil, fmt.Errorf("apply conflict curation %s: %w", event.Kind, err)
		}
	}
	snapshot, tripleCount, err := service.generationNQuads(ctx, projectID, candidate.ID, ontologyID)
	if err != nil {
		return nil, err
	}
	receipt, err := service.CAS.PutBytes(snapshot)
	if err != nil {
		return nil, err
	}
	if _, err := service.CAS.ReadVerified(receipt.Hash); err != nil {
		return nil, err
	}
	if err := service.DB.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		return nil, err
	}
	snapshotID, err := id.New("krdf")
	if err != nil {
		return nil, err
	}
	if err := service.DB.AppendKnowledgeProjection(ctx, projectID, candidate.ID, store.KnowledgeProjection{Snapshots: []store.KnowledgeRDFSnapshotRecord{{
		ID: snapshotID, Format: "n-quads", BlobHash: receipt.Hash, DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
	}}}); err != nil {
		return nil, err
	}
	service.checkpointDurabilityTest("pinned_after_snapshot_publish")
	if _, err := service.DB.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		return nil, err
	}
	state = store.KnowledgeValidating
	if err := service.Sidecar.LoadSnapshot(ctx, projectID, candidate.ID, snapshot, receipt.Hash, tripleCount); err != nil {
		return nil, fmt.Errorf("validate RDF snapshot in Oxigraph: %w", err)
	}
	ready, err := service.DB.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, "")
	if err != nil {
		return nil, err
	}
	state = store.KnowledgeReady
	service.checkpointDurabilityTest("pinned_before_head_swap")
	activated, err := service.DB.ActivateKnowledgeGeneration(ctx, projectID, ready.ID)
	if err != nil {
		return nil, err
	}
	service.checkpointDurabilityTest("pinned_after_head_swap")
	return map[string]any{"generation": ready, "knowledge_head": activated, "triple_count": tripleCount}, nil
}

// quarantineIncompleteRebuildCandidates terminalizes only candidates created
// by this deterministic rebuild contract. A process exit before the RDF
// snapshot commit must not leave the per-project building-generation guard
// permanently occupied. Snapshot-complete pinned candidates are recovered
// before this function runs, so no external model turn is resent here.
func (service *Service) quarantineIncompleteRebuildCandidates(ctx context.Context, projectID, contractSHA256 string) error {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT g.id,g.state
FROM knowledge_generations g
WHERE g.project_id=? AND g.contract_sha256=? AND g.state IN('building','validating')
  AND NOT EXISTS(SELECT 1 FROM project_knowledge_heads h WHERE h.project_id=g.project_id AND h.generation_id=g.id)
ORDER BY g.created_at,g.id`, projectID, contractSHA256)
	if err != nil {
		return err
	}
	type interruptedCandidate struct {
		id    string
		state store.KnowledgeGenerationState
	}
	var candidates []interruptedCandidate
	for rows.Next() {
		var candidate interruptedCandidate
		if err := rows.Scan(&candidate.id, &candidate.state); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	reason := errors.New("startup recovery quarantined an incomplete deterministic knowledge rebuild")
	for _, candidate := range candidates {
		if candidate.state == store.KnowledgeBuilding {
			if err := service.failOpenExtractionBatches(ctx, projectID, candidate.id, errors.Join(context.Canceled, reason)); err != nil {
				return err
			}
		}
		if _, err := service.DB.TransitionKnowledgeGeneration(
			ctx, projectID, candidate.id, candidate.state, store.KnowledgeFailed, reason.Error(),
		); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) copyActiveProjection(ctx context.Context, projectID string, source, target store.KnowledgeGeneration) error {
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	copyStatements := []string{
		`INSERT INTO knowledge_sources(project_id,generation_id,chunk_id,blob_hash,source_kind,source_locator_json,text_hash,created_at)
 SELECT project_id,?,chunk_id,blob_hash,source_kind,source_locator_json,text_hash,created_at FROM knowledge_sources WHERE project_id=? AND generation_id=?`,
		`INSERT INTO knowledge_entities(project_id,generation_id,id,class_key,canonical_name,normalized_name,description,identity_key,created_at)
 SELECT project_id,?,id,class_key,canonical_name,normalized_name,description,identity_key,created_at FROM knowledge_entities WHERE project_id=? AND generation_id=?`,
		`INSERT INTO knowledge_aliases(project_id,generation_id,entity_id,alias,normalized_alias,language,created_at)
 SELECT project_id,?,entity_id,alias,normalized_alias,language,created_at FROM knowledge_aliases WHERE project_id=? AND generation_id=?`,
		`INSERT INTO knowledge_mentions(project_id,generation_id,id,entity_id,chunk_id,start_byte,end_byte,excerpt_sha256,created_at)
 SELECT project_id,?,id,entity_id,chunk_id,start_byte,end_byte,excerpt_sha256,created_at FROM knowledge_mentions WHERE project_id=? AND generation_id=?`,
	}
	for _, statement := range copyStatements {
		if _, err := tx.ExecContext(ctx, statement, target.ID, projectID, source.ID); err != nil {
			return err
		}
	}
	if err := copyCanonicalKnowledgeAssertions(ctx, tx, projectID, source.ID, target.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO knowledge_assertion_evidence(
 project_id,generation_id,assertion_id,evidence_kind,blob_hash,chunk_id,claim_id,source_id,start_byte,end_byte,locator_json,evidence_sha256,created_at)
 SELECT e.project_id,?,e.assertion_id,e.evidence_kind,e.blob_hash,e.chunk_id,e.claim_id,e.source_id,e.start_byte,e.end_byte,e.locator_json,e.evidence_sha256,e.created_at
 FROM knowledge_assertion_evidence e JOIN knowledge_assertions a
 ON a.project_id=e.project_id AND a.generation_id=? AND a.id=e.assertion_id
 WHERE e.project_id=? AND e.generation_id=?`, target.ID, target.ID, projectID, source.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO knowledge_conflicts(
 project_id,generation_id,id,left_assertion_id,right_assertion_id,reason,status,created_at,resolved_at)
 SELECT c.project_id,?,c.id,c.left_assertion_id,c.right_assertion_id,c.reason,c.status,c.created_at,c.resolved_at
 FROM knowledge_conflicts c
 WHERE c.project_id=? AND c.generation_id=?
 AND EXISTS(SELECT 1 FROM knowledge_assertions a WHERE a.project_id=c.project_id AND a.generation_id=? AND a.id=c.left_assertion_id)
 AND EXISTS(SELECT 1 FROM knowledge_assertions a WHERE a.project_id=c.project_id AND a.generation_id=? AND a.id=c.right_assertion_id)`,
		target.ID, projectID, source.ID, target.ID, target.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func copyCanonicalKnowledgeAssertions(ctx context.Context, tx *sql.Tx, projectID, sourceGenerationID, targetGenerationID string) error {
	rows, err := tx.QueryContext(ctx, `
SELECT a.id,a.subject_entity_id,a.predicate_key,a.object_entity_id,a.literal_json,a.qualifiers_json,a.polarity,
       COALESCE(a.valid_from,''),COALESCE(a.valid_to,''),a.status,a.confidence,a.created_at
FROM knowledge_assertions a
WHERE a.project_id=? AND a.generation_id=?
AND NOT EXISTS(SELECT 1 FROM knowledge_inferences i
 WHERE i.project_id=a.project_id AND i.generation_id=a.generation_id AND i.conclusion_assertion_id=a.id)
ORDER BY a.id`, projectID, sourceGenerationID)
	if err != nil {
		return err
	}
	type copiedAssertion struct {
		id, subject, predicate, literal, qualifiers, polarity string
		validFrom, validTo, status, createdAt                 string
		object                                                sql.NullString
		confidence                                            float64
		key                                                   string
	}
	var assertions []copiedAssertion
	for rows.Next() {
		var value copiedAssertion
		if err := rows.Scan(&value.id, &value.subject, &value.predicate, &value.object,
			&value.literal, &value.qualifiers, &value.polarity, &value.validFrom, &value.validTo,
			&value.status, &value.confidence, &value.createdAt); err != nil {
			rows.Close()
			return err
		}
		value.validFrom, value.validTo, err = core.CanonicalKnowledgeInterval(value.validFrom, value.validTo)
		if err != nil {
			rows.Close()
			return fmt.Errorf("copy assertion %s validity: %w", value.id, err)
		}
		canonicalQualifiers, err := canonicalReasoningJSON(value.qualifiers)
		if err != nil {
			rows.Close()
			return fmt.Errorf("copy assertion %s qualifiers: %w", value.id, err)
		}
		canonicalLiteral := value.literal
		if canonicalLiteral != "" {
			canonicalLiteral, err = canonicalReasoningJSON(canonicalLiteral)
			if err != nil {
				rows.Close()
				return fmt.Errorf("copy assertion %s literal: %w", value.id, err)
			}
		}
		value.key = reasoningSHA256(strings.Join([]string{
			value.subject, value.predicate, value.object.String, canonicalLiteral,
			canonicalQualifiers, value.validFrom, value.validTo,
		}, "\x00"))
		assertions = append(assertions, value)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, value := range assertions {
		if _, err := tx.ExecContext(ctx, `INSERT INTO knowledge_assertions(
 project_id,generation_id,id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,
 valid_from,valid_to,status,confidence,assertion_key,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,NULLIF(?,''),NULLIF(?,''),?,?,?,?)`, projectID, targetGenerationID,
			value.id, value.subject, value.predicate, nullableString(value.object), value.literal,
			value.qualifiers, value.polarity, value.validFrom, value.validTo, value.status,
			value.confidence, value.key, value.createdAt); err != nil {
			return fmt.Errorf("copy assertion %s: %w", value.id, err)
		}
	}
	return nil
}

type pendingKnowledgeCuration struct {
	Kind    string
	Payload json.RawMessage
}

func (service *Service) applyPendingCuration(ctx context.Context, projectID, sourceGenerationID, targetGenerationID string) ([]pendingKnowledgeCuration, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT kind,payload_json FROM knowledge_curation_events WHERE project_id=? AND generation_id=? ORDER BY sequence`, projectID, sourceGenerationID)
	if err != nil {
		return nil, err
	}
	var events []pendingKnowledgeCuration
	for rows.Next() {
		var item pendingKnowledgeCuration
		var payload string
		if err := rows.Scan(&item.Kind, &payload); err != nil {
			rows.Close()
			return nil, err
		}
		item.Payload = json.RawMessage(payload)
		events = append(events, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	var conflictEvents []pendingKnowledgeCuration
	for _, item := range events {
		if item.Kind == "resolve_conflict" || item.Kind == "dismiss_conflict" {
			conflictEvents = append(conflictEvents, item)
			continue
		}
		if err := service.applyCurationEvent(ctx, projectID, targetGenerationID, item.Kind, item.Payload); err != nil {
			return nil, fmt.Errorf("apply curation %s: %w", item.Kind, err)
		}
	}
	return conflictEvents, nil
}

func (service *Service) materializeCurationMemoSource(
	ctx context.Context, projectID, generationID string, value map[string]any, now string,
) ([]curationEvidenceCopy, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var binding curationMemoBinding
	if err := json.Unmarshal(encoded, &binding); err != nil {
		return nil, errors.New("curation memo binding is invalid")
	}
	present := binding.MemoBlobHash != "" || binding.MemoDocumentID != "" || binding.MemoStartByte != 0 ||
		binding.MemoEndByte != 0 || binding.MemoSpanSHA256 != "" || len(binding.MemoChunks) != 0
	if !present {
		return nil, nil
	}
	if binding.MemoBlobHash == "" || binding.MemoDocumentID == "" || binding.MemoStartByte != 0 ||
		binding.MemoEndByte <= 0 || binding.MemoSpanSHA256 != binding.MemoBlobHash ||
		len(binding.MemoChunks) == 0 {
		return nil, errors.New("curation memo binding is incomplete")
	}
	data, err := service.CAS.ReadVerified(binding.MemoBlobHash)
	if err != nil {
		return nil, fmt.Errorf("curation memo CAS readback: %w", err)
	}
	if !utf8.Valid(data) || binding.MemoEndByte != len(data) || hashBytes(data) != binding.MemoSpanSHA256 {
		return nil, errors.New("curation memo CAS hash/span mismatch")
	}
	var documentBlob, status string
	var pinned, curationMemo int
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT blob_hash,status,pinned,curation_memo FROM documents WHERE id=? AND project_id=?`,
		binding.MemoDocumentID, projectID).Scan(&documentBlob, &status, &pinned, &curationMemo); err != nil {
		return nil, errors.New("curation memo document does not belong to the project")
	}
	if documentBlob != binding.MemoBlobHash || status != "ready" || pinned != 1 || curationMemo != 1 {
		return nil, errors.New("curation memo document is not a ready pinned copy of the CAS blob")
	}
	var chunkCount int
	if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM chunks WHERE document_id=?`, binding.MemoDocumentID).Scan(&chunkCount); err != nil {
		return nil, err
	}
	if chunkCount != len(binding.MemoChunks) || chunkCount == 0 {
		return nil, errors.New("curation memo binding does not cover every deterministic chunk")
	}
	locator, _ := json.Marshal(struct {
		CurationMemo bool   `json:"curation_memo"`
		DocumentID   string `json:"document_id"`
		BlobHash     string `json:"blob_hash"`
	}{true, binding.MemoDocumentID, binding.MemoBlobHash})
	evidence := make([]curationEvidenceCopy, 0, len(binding.MemoChunks))
	seenChunks, seenEvidence := map[string]bool{}, map[string]bool{}
	for index, chunk := range binding.MemoChunks {
		if chunk.ChunkID == "" || seenChunks[chunk.ChunkID] || chunk.StartByte != 0 || chunk.EndByte <= 0 {
			return nil, errors.New("curation memo chunk binding is invalid or duplicated")
		}
		seenChunks[chunk.ChunkID] = true
		var ordinal int
		var text, textHash string
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT ordinal,text,text_hash FROM chunks WHERE id=? AND document_id=?`,
			chunk.ChunkID, binding.MemoDocumentID).Scan(&ordinal, &text, &textHash); err != nil {
			return nil, errors.New("curation memo chunk does not belong to the pinned document")
		}
		chunkData := []byte(text)
		if ordinal != index || !utf8.Valid(chunkData) || chunk.EndByte != len(chunkData) ||
			hashBytes(chunkData[chunk.StartByte:chunk.EndByte]) != chunk.SpanSHA256 || textHash != chunk.SpanSHA256 {
			return nil, errors.New("curation memo chunk hash/span mismatch")
		}
		if _, err := service.DB.SQL().ExecContext(ctx, `
INSERT OR IGNORE INTO knowledge_sources(
 project_id,generation_id,chunk_id,blob_hash,source_kind,source_locator_json,text_hash,created_at
) VALUES(?,?,?,?,'pinned',?,?,?)`, projectID, generationID, chunk.ChunkID,
			binding.MemoBlobHash, string(locator), textHash, now); err != nil {
			return nil, err
		}
		var storedBlob, storedHash string
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT blob_hash,text_hash FROM knowledge_sources
WHERE project_id=? AND generation_id=? AND chunk_id=?`, projectID, generationID, chunk.ChunkID).Scan(&storedBlob, &storedHash); err != nil {
			return nil, err
		}
		if storedBlob != binding.MemoBlobHash || storedHash != textHash {
			return nil, errors.New("curation memo source conflicts with generation provenance")
		}
		evidenceKey := binding.MemoBlobHash + "\x00" + chunk.SpanSHA256
		if seenEvidence[evidenceKey] {
			continue
		}
		seenEvidence[evidenceKey] = true
		claimMaterial := strings.Join([]string{binding.MemoDocumentID, chunk.ChunkID,
			fmt.Sprintf("%d", chunk.StartByte), fmt.Sprintf("%d", chunk.EndByte), chunk.SpanSHA256}, "\x00")
		claimSum := sha256.Sum256([]byte(claimMaterial))
		evidence = append(evidence, curationEvidenceCopy{
			Kind: "text_span", BlobHash: binding.MemoBlobHash, ChunkID: chunk.ChunkID,
			ClaimID: "claim_" + hex.EncodeToString(claimSum[:16]), SourceID: "curation_memo:" + binding.MemoDocumentID,
			Start: sql.NullInt64{Int64: int64(chunk.StartByte), Valid: true},
			End:   sql.NullInt64{Int64: int64(chunk.EndByte), Valid: true}, Locator: "{}", Hash: chunk.SpanSHA256,
		})
	}
	if len(evidence) == 0 {
		return nil, errors.New("curation memo produced no unique evidence spans")
	}
	return evidence, nil
}

func (service *Service) applyCurationEvent(ctx context.Context, projectID, generationID, kind string, payload json.RawMessage) error {
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		return err
	}
	object := value
	if nested, ok := value["entity"].(map[string]any); ok && kind == "add_entity" {
		object = nested
	}
	if nested, ok := value["assertion"].(map[string]any); ok && (kind == "add_assertion" || kind == "update_assertion") {
		object = nested
	}
	text := func(key string) string { result, _ := object[key].(string); return strings.TrimSpace(result) }
	now := time.Now().UTC().Format(time.RFC3339Nano)
	memoEvidence, err := service.materializeCurationMemoSource(ctx, projectID, generationID, value, now)
	if err != nil {
		return err
	}
	switch kind {
	case "add_entity":
		entityID, classKey, name := text("id"), text("class_key"), text("canonical_name")
		if classKey == "" {
			classKey = text("type")
		}
		if entityID == "" || classKey == "" || name == "" {
			return errors.New("add_entity requires entity.id, class_key/type, and canonical_name")
		}
		if _, err := service.DB.SQL().ExecContext(ctx, `INSERT INTO knowledge_entities(project_id,generation_id,id,class_key,canonical_name,normalized_name,description,identity_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
			projectID, generationID, entityID, classKey, name, normalizeKnowledgeName(name), text("description"), text("identity_key"), now); err != nil {
			return err
		}
		evidenceIDs := stringSlice(value["evidence_ids"])
		if len(evidenceIDs) == 0 {
			evidenceIDs = stringSlice(object["evidence_ids"])
		}
		var selected curationEvidenceCopy
		if len(evidenceIDs) != 0 {
			if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT evidence_kind,blob_hash,COALESCE(chunk_id,''),claim_id,source_id,start_byte,end_byte,locator_json,evidence_sha256
FROM knowledge_assertion_evidence
WHERE project_id=? AND generation_id=? AND evidence_kind='text_span' AND evidence_sha256=?
ORDER BY assertion_id,blob_hash LIMIT 1`, projectID, generationID, firstString(evidenceIDs)).Scan(
				&selected.Kind, &selected.BlobHash, &selected.ChunkID, &selected.ClaimID, &selected.SourceID,
				&selected.Start, &selected.End, &selected.Locator, &selected.Hash); err != nil {
				return errors.New("add_entity requires text-span evidence in the active graph")
			}
		} else if len(memoEvidence) != 0 {
			selected = memoEvidence[0]
		} else {
			return errors.New("add_entity requires existing text-span evidence or a pinned curation memo")
		}
		if !selected.Start.Valid || !selected.End.Valid {
			return errors.New("add_entity text-span evidence is incomplete")
		}
		mentionMaterial := strings.Join([]string{entityID, selected.ChunkID,
			fmt.Sprintf("%d", selected.Start.Int64), fmt.Sprintf("%d", selected.End.Int64), selected.Hash}, "\x00")
		mentionSum := sha256.Sum256([]byte(mentionMaterial))
		mentionID := "kmen_" + hex.EncodeToString(mentionSum[:16])
		_, err = service.DB.SQL().ExecContext(ctx, `INSERT OR IGNORE INTO knowledge_mentions(project_id,generation_id,id,entity_id,chunk_id,start_byte,end_byte,excerpt_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
			projectID, generationID, mentionID, entityID, selected.ChunkID, selected.Start.Int64, selected.End.Int64, selected.Hash, now)
		if err != nil {
			return err
		}
		var storedEntity, storedChunk, storedHash string
		var storedStart, storedEnd int64
		if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT entity_id,chunk_id,start_byte,end_byte,excerpt_sha256 FROM knowledge_mentions
WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, mentionID).Scan(
			&storedEntity, &storedChunk, &storedStart, &storedEnd, &storedHash); err != nil {
			return errors.New("deterministic curation mention could not be persisted")
		}
		if storedEntity != entityID || storedChunk != selected.ChunkID || storedStart != selected.Start.Int64 ||
			storedEnd != selected.End.Int64 || storedHash != selected.Hash {
			return errors.New("deterministic curation mention id collision")
		}
		return nil
	case "add_alias":
		entityID := textFrom(value, "entity_id")
		alias := textFrom(value, "alias")
		if alias == "" {
			alias = textFrom(value, "value")
		}
		if entityID == "" || alias == "" {
			return errors.New("add_alias requires entity_id and alias")
		}
		_, err := service.DB.SQL().ExecContext(ctx, `INSERT INTO knowledge_aliases(project_id,generation_id,entity_id,alias,normalized_alias,language,created_at) VALUES(?,?,?,?,?,?,?)`, projectID, generationID, entityID, alias, normalizeKnowledgeName(alias), textFrom(value, "language"), now)
		return err
	case "add_assertion":
		assertionID, subject, predicate := text("id"), text("subject_entity_id"), text("predicate_key")
		if predicate == "" {
			predicate = text("predicate")
		}
		objectID := text("object_entity_id")
		literal := object["object_literal"]
		if literal == nil {
			literal = object["literal"]
		}
		literalJSON := ""
		if literal != nil {
			if err := validateCurationTypedLiteral(literal); err != nil {
				return fmt.Errorf("add_assertion literal: %w", err)
			}
			data, err := json.Marshal(literal)
			if err != nil {
				return err
			}
			literalJSON = string(data)
		}
		if assertionID == "" || subject == "" || predicate == "" || (objectID == "") == (literalJSON == "") {
			return errors.New("add_assertion requires id, subject, predicate, and exactly one object")
		}
		if err := validateCurationQualifiers(object["qualifiers"]); err != nil {
			return fmt.Errorf("add_assertion qualifiers: %w", err)
		}
		qualifiers, _ := json.Marshal(object["qualifiers"])
		if string(qualifiers) == "null" {
			qualifiers = []byte("{}")
		}
		validFrom, validTo := "", ""
		if interval, ok := object["valid_time"].(map[string]any); ok {
			validFrom, _ = interval["start"].(string)
			validTo, _ = interval["end"].(string)
		}
		validFrom, validTo, err = canonicalCurationInterval(validFrom, validTo)
		if err != nil {
			return err
		}
		keyMaterial := strings.Join([]string{subject, predicate, objectID, literalJSON, string(qualifiers), validFrom, validTo}, "\x00")
		keySum := sha256.Sum256([]byte(keyMaterial))
		if _, err := service.DB.SQL().ExecContext(ctx, `INSERT INTO knowledge_assertions(project_id,generation_id,id,subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,polarity,valid_from,valid_to,status,confidence,assertion_key,created_at) VALUES(?,?,?,?,?,NULLIF(?,''),?,?,?,NULLIF(?,''),NULLIF(?,''),'accepted',1,?,?)`, projectID, generationID, assertionID, subject, predicate, objectID, literalJSON, string(qualifiers), "affirmed", validFrom, validTo, hex.EncodeToString(keySum[:]), now); err != nil {
			return err
		}
		evidenceIDs := stringSlice(value["evidence_ids"])
		if len(evidenceIDs) == 0 {
			evidenceIDs = stringSlice(object["evidence_ids"])
		}
		for _, evidenceID := range evidenceIDs {
			result, err := service.DB.SQL().ExecContext(ctx, `INSERT INTO knowledge_assertion_evidence(project_id,generation_id,assertion_id,evidence_kind,blob_hash,chunk_id,claim_id,source_id,start_byte,end_byte,locator_json,evidence_sha256,created_at) SELECT project_id,generation_id,?,evidence_kind,blob_hash,chunk_id,claim_id,source_id,start_byte,end_byte,locator_json,evidence_sha256,? FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=? AND evidence_sha256=?`, assertionID, now, projectID, generationID, evidenceID)
			if err != nil {
				return err
			}
			if count, _ := result.RowsAffected(); count == 0 {
				return fmt.Errorf("evidence %s is not available in the target generation", evidenceID)
			}
		}
		for _, item := range memoEvidence {
			if err := insertCurationAssertionEvidence(ctx, service.DB.SQL(), projectID, generationID, assertionID, item, now); err != nil {
				return err
			}
		}
		return nil
	case "update_assertion":
		return service.applyAssertionUpdate(ctx, projectID, generationID, value, object, memoEvidence, now)
	case "retract_assertion", "restore_assertion":
		assertionID := textFrom(value, "assertion_id")
		if assertionID == "" {
			assertionID = text("id")
		}
		status := textFrom(value, "status")
		if kind == "retract_assertion" {
			status = "retracted"
		} else if kind == "restore_assertion" {
			status = "accepted"
		}
		if assertionID == "" || (status != "accepted" && status != "disputed" && status != "superseded" && status != "retracted") {
			return errors.New("assertion update requires assertion_id and a supported status")
		}
		result, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET status=? WHERE project_id=? AND generation_id=? AND id=?`, status, projectID, generationID, assertionID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return store.ErrNotFound
		}
		return nil
	case "merge_entities":
		survivor := textFrom(value, "survivor_id")
		merged := stringSlice(value["merged_ids"])
		if survivor == "" || len(merged) == 0 {
			return errors.New("merge_entities requires survivor_id and merged_ids")
		}
		for _, mergedID := range merged {
			if mergedID == survivor {
				return errors.New("an entity cannot be merged into itself")
			}
			if _, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET subject_entity_id=? WHERE project_id=? AND generation_id=? AND subject_entity_id=?`, survivor, projectID, generationID, mergedID); err != nil {
				return err
			}
			if _, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET object_entity_id=? WHERE project_id=? AND generation_id=? AND object_entity_id=?`, survivor, projectID, generationID, mergedID); err != nil {
				return err
			}
			if _, err := service.DB.SQL().ExecContext(ctx, `INSERT OR IGNORE INTO knowledge_aliases(project_id,generation_id,entity_id,alias,normalized_alias,language,created_at) SELECT project_id,generation_id,?,alias,normalized_alias,language,created_at FROM knowledge_aliases WHERE project_id=? AND generation_id=? AND entity_id=?`, survivor, projectID, generationID, mergedID); err != nil {
				return err
			}
			if _, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_mentions SET entity_id=? WHERE project_id=? AND generation_id=? AND entity_id=?`, survivor, projectID, generationID, mergedID); err != nil {
				return err
			}
			if _, err := service.DB.SQL().ExecContext(ctx, `DELETE FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, mergedID); err != nil {
				return err
			}
		}
		return nil
	case "split_entity":
		sourceID := textFrom(value, "source_entity_id")
		newEntities, ok := value["new_entities"].([]any)
		if sourceID == "" || !ok || len(newEntities) < 2 {
			return errors.New("split_entity requires source_entity_id and at least two new_entities")
		}
		defaultEvidence := stringSlice(value["evidence_ids"])
		created := map[string]bool{}
		for _, rawEntity := range newEntities {
			entity, ok := rawEntity.(map[string]any)
			if !ok {
				return errors.New("split_entity new_entities must be objects")
			}
			entityID, _ := entity["id"].(string)
			entityID = strings.TrimSpace(entityID)
			if entityID == "" || entityID == sourceID || created[entityID] {
				return errors.New("split_entity new entity ids must be unique and distinct from the source")
			}
			created[entityID] = true
			evidenceIDs := stringSlice(entity["evidence_ids"])
			if len(evidenceIDs) == 0 {
				evidenceIDs = defaultEvidence
			}
			nested := map[string]any{"entity": entity, "evidence_ids": evidenceIDs}
			for _, field := range reservedCurationMemoFields {
				if memoValue, exists := value[field]; exists {
					nested[field] = memoValue
				}
			}
			normalized, _ := json.Marshal(nested)
			if err := service.applyCurationEvent(ctx, projectID, generationID, "add_entity", normalized); err != nil {
				return err
			}
		}
		assignments, ok := value["assertion_assignments"].([]any)
		if !ok || len(assignments) == 0 {
			return errors.New("split_entity requires explicit assertion_assignments")
		}
		for _, rawAssignment := range assignments {
			assignment, ok := rawAssignment.(map[string]any)
			if !ok {
				return errors.New("split_entity assertion assignments must be objects")
			}
			assertionID := textFrom(assignment, "assertion_id")
			subjectID := textFrom(assignment, "subject_entity_id")
			objectID := textFrom(assignment, "object_entity_id")
			if assertionID == "" || (subjectID == "" && objectID == "") || (subjectID != "" && !created[subjectID]) || (objectID != "" && !created[objectID]) {
				return errors.New("split_entity assignments must target a created entity")
			}
			var currentSubject string
			var currentObject sql.NullString
			if err := service.DB.SQL().QueryRowContext(ctx, `SELECT subject_entity_id,object_entity_id FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, assertionID).Scan(&currentSubject, &currentObject); err != nil {
				return err
			}
			if subjectID != "" {
				if currentSubject != sourceID {
					return fmt.Errorf("assertion %s subject is not the split source", assertionID)
				}
				if _, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET subject_entity_id=? WHERE project_id=? AND generation_id=? AND id=?`, subjectID, projectID, generationID, assertionID); err != nil {
					return err
				}
			}
			if objectID != "" {
				if !currentObject.Valid || currentObject.String != sourceID {
					return fmt.Errorf("assertion %s object is not the split source", assertionID)
				}
				if _, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_assertions SET object_entity_id=? WHERE project_id=? AND generation_id=? AND id=?`, objectID, projectID, generationID, assertionID); err != nil {
					return err
				}
			}
		}
		var remaining int
		if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_assertions WHERE project_id=? AND generation_id=? AND (subject_entity_id=? OR object_entity_id=?)`, projectID, generationID, sourceID, sourceID).Scan(&remaining); err != nil {
			return err
		}
		if remaining != 0 {
			return fmt.Errorf("split_entity leaves %d assertions assigned to the source", remaining)
		}
		if _, err := service.DB.SQL().ExecContext(ctx, `DELETE FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, sourceID); err != nil {
			return err
		}
		return nil
	case "resolve_conflict", "dismiss_conflict":
		conflictID := textFrom(value, "conflict_id")
		status := "resolved"
		if kind == "dismiss_conflict" {
			status = "dismissed"
		}
		result, err := service.DB.SQL().ExecContext(ctx, `UPDATE knowledge_conflicts SET status=?,resolved_at=? WHERE project_id=? AND generation_id=? AND id=?`, status, now, projectID, generationID, conflictID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return store.ErrNotFound
		}
		return nil
	case "pin_entity":
		entityID := textFrom(value, "entity_id")
		if entityID == "" {
			return errors.New("pin_entity requires entity_id")
		}
		var exists int
		if err := service.DB.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_entities WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, entityID).Scan(&exists); err != nil {
			return err
		}
		if exists != 1 {
			return store.ErrNotFound
		}
		return nil
	default:
		return fmt.Errorf("curation kind %s has no deterministic materializer", kind)
	}
}

type curationEvidenceCopy struct {
	Kind, BlobHash, ChunkID, ClaimID, SourceID, Locator, Hash string
	Start, End                                                sql.NullInt64
}

type curationEvidenceExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertCurationAssertionEvidence(
	ctx context.Context, executor curationEvidenceExecutor,
	projectID, generationID, assertionID string, item curationEvidenceCopy, now string,
) error {
	if item.BlobHash == "" || item.Hash == "" {
		return errors.New("curation assertion evidence is incomplete")
	}
	switch item.Kind {
	case "text_span":
		if item.ChunkID == "" || !item.Start.Valid || !item.End.Valid || item.End.Int64 <= item.Start.Int64 || item.Locator != "{}" {
			return errors.New("curation text-span evidence is incomplete")
		}
	case "artifact_value":
		if item.ChunkID != "" || item.Start.Valid || item.End.Valid || item.Locator == "" || item.Locator == "{}" {
			return errors.New("curation artifact evidence is incomplete")
		}
	default:
		return errors.New("curation assertion evidence kind is unsupported")
	}
	_, err := executor.ExecContext(ctx, `
INSERT OR IGNORE INTO knowledge_assertion_evidence(
 project_id,generation_id,assertion_id,evidence_kind,blob_hash,chunk_id,claim_id,source_id,
 start_byte,end_byte,locator_json,evidence_sha256,created_at
) VALUES(?,?,?,?,?,NULLIF(?,''),?,?,?, ?,?,?,?)`, projectID, generationID, assertionID, item.Kind, item.BlobHash,
		item.ChunkID, item.ClaimID, item.SourceID, nullableInt64(item.Start), nullableInt64(item.End), item.Locator, item.Hash, now)
	return err
}

func (service *Service) applyAssertionUpdate(
	ctx context.Context,
	projectID, generationID string,
	envelope, object map[string]any,
	memoEvidence []curationEvidenceCopy,
	now string,
) error {
	text := func(key string) string {
		value, _ := object[key].(string)
		return strings.TrimSpace(value)
	}
	assertionID := strings.TrimSpace(textFrom(envelope, "assertion_id"))
	if assertionID == "" {
		assertionID = text("id")
	}
	if assertionID == "" {
		return errors.New("update_assertion requires assertion_id")
	}
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var subject, predicate, literalJSON, qualifiers, polarity, status string
	var objectID, validFrom, validTo sql.NullString
	var confidence float64
	if err := tx.QueryRowContext(ctx, `
SELECT subject_entity_id,predicate_key,object_entity_id,literal_json,qualifiers_json,
       polarity,valid_from,valid_to,status,confidence
FROM knowledge_assertions
WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, assertionID).Scan(
		&subject, &predicate, &objectID, &literalJSON, &qualifiers, &polarity,
		&validFrom, &validTo, &status, &confidence,
	); err != nil {
		return knowledgeLookupError(err)
	}
	if _, present := object["subject_entity_id"]; present {
		subject = text("subject_entity_id")
	}
	if _, present := object["predicate_key"]; present {
		predicate = text("predicate_key")
	} else if _, present := object["predicate"]; present {
		predicate = text("predicate")
	}
	_, hasObjectEntity := object["object_entity_id"]
	literal, hasObjectLiteral := object["object_literal"]
	if !hasObjectLiteral {
		literal, hasObjectLiteral = object["literal"]
	}
	if hasObjectEntity && hasObjectLiteral {
		return errors.New("update_assertion accepts only one object representation")
	}
	if hasObjectEntity {
		objectID = sql.NullString{String: text("object_entity_id"), Valid: text("object_entity_id") != ""}
		literalJSON = ""
	}
	if hasObjectLiteral {
		if literal == nil {
			return errors.New("update_assertion literal cannot be null")
		}
		if err := validateCurationTypedLiteral(literal); err != nil {
			return fmt.Errorf("update_assertion literal: %w", err)
		}
		encoded, err := json.Marshal(literal)
		if err != nil {
			return err
		}
		literalJSON = string(encoded)
		objectID = sql.NullString{}
	}
	if subject == "" || predicate == "" || (objectID.Valid == (literalJSON != "")) {
		return errors.New("update_assertion requires subject, predicate, and exactly one object")
	}
	if rawQualifiers, present := object["qualifiers"]; present {
		if rawQualifiers == nil {
			rawQualifiers = map[string]any{}
		}
		if err := validateCurationQualifiers(rawQualifiers); err != nil {
			return fmt.Errorf("update_assertion qualifiers: %w", err)
		}
		encoded, err := json.Marshal(rawQualifiers)
		if err != nil {
			return err
		}
		var qualifierObject map[string]any
		if err := json.Unmarshal(encoded, &qualifierObject); err != nil || qualifierObject == nil {
			return errors.New("update_assertion qualifiers must be a JSON object")
		}
		qualifiers = string(encoded)
	}
	if rawInterval, present := object["valid_time"]; present {
		interval, ok := rawInterval.(map[string]any)
		if !ok && rawInterval != nil {
			return errors.New("update_assertion valid_time must be an object")
		}
		from, to := "", ""
		if interval != nil {
			from, _ = interval["start"].(string)
			to, _ = interval["end"].(string)
		}
		from, to, err = canonicalCurationInterval(from, to)
		if err != nil {
			return err
		}
		validFrom = sql.NullString{String: from, Valid: from != ""}
		validTo = sql.NullString{String: to, Valid: to != ""}
	}
	canonicalFrom, canonicalTo, err := canonicalCurationInterval(validFrom.String, validTo.String)
	if err != nil {
		return err
	}
	validFrom = sql.NullString{String: canonicalFrom, Valid: canonicalFrom != ""}
	validTo = sql.NullString{String: canonicalTo, Valid: canonicalTo != ""}
	if value, present := object["polarity"]; present {
		polarity, _ = value.(string)
		if polarity != "affirmed" && polarity != "negated" {
			return errors.New("update_assertion polarity must be affirmed or negated")
		}
	}
	if value, present := object["status"]; present {
		status, _ = value.(string)
		if status != "accepted" && status != "disputed" && status != "superseded" && status != "retracted" {
			return errors.New("update_assertion status is invalid")
		}
	}
	if value, present := object["confidence"]; present {
		confidence, _ = value.(float64)
		if confidence < 0 || confidence > 1 {
			return errors.New("update_assertion confidence must be between zero and one")
		}
	}
	keyMaterial := strings.Join([]string{subject, predicate, objectID.String, literalJSON, qualifiers, validFrom.String, validTo.String}, "\x00")
	keySum := sha256.Sum256([]byte(keyMaterial))
	evidenceIDs := stringSlice(envelope["evidence_ids"])
	if len(evidenceIDs) == 0 {
		evidenceIDs = stringSlice(object["evidence_ids"])
	}
	var selectedEvidence []curationEvidenceCopy
	for _, evidenceID := range evidenceIDs {
		rows, err := tx.QueryContext(ctx, `
SELECT evidence_kind,blob_hash,COALESCE(chunk_id,''),claim_id,source_id,start_byte,end_byte,locator_json,evidence_sha256
FROM knowledge_assertion_evidence
WHERE project_id=? AND generation_id=? AND evidence_sha256=?
ORDER BY assertion_id,evidence_kind,blob_hash`, projectID, generationID, evidenceID)
		if err != nil {
			return err
		}
		matched := false
		for rows.Next() {
			var item curationEvidenceCopy
			if err := rows.Scan(&item.Kind, &item.BlobHash, &item.ChunkID, &item.ClaimID, &item.SourceID,
				&item.Start, &item.End, &item.Locator, &item.Hash); err != nil {
				rows.Close()
				return err
			}
			selectedEvidence = append(selectedEvidence, item)
			matched = true
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if !matched {
			return fmt.Errorf("evidence %s is not available in the target generation", evidenceID)
		}
	}
	selectedEvidence = append(selectedEvidence, memoEvidence...)
	if _, err := tx.ExecContext(ctx, `
UPDATE knowledge_assertions
SET subject_entity_id=?,predicate_key=?,object_entity_id=?,literal_json=?,qualifiers_json=?,
    polarity=?,valid_from=?,valid_to=?,status=?,confidence=?,assertion_key=?
WHERE project_id=? AND generation_id=? AND id=?`, subject, predicate, nullableString(objectID), literalJSON,
		qualifiers, polarity, nullableString(validFrom), nullableString(validTo), status, confidence,
		hex.EncodeToString(keySum[:]), projectID, generationID, assertionID); err != nil {
		return err
	}
	if len(evidenceIDs) != 0 || len(memoEvidence) != 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_assertion_evidence WHERE project_id=? AND generation_id=? AND assertion_id=?`, projectID, generationID, assertionID); err != nil {
			return err
		}
		for _, item := range selectedEvidence {
			if err := insertCurationAssertionEvidence(ctx, tx, projectID, generationID, assertionID, item, now); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func validateCurationInterval(from, to string) error {
	_, _, err := canonicalCurationInterval(from, to)
	return err
}

func canonicalCurationInterval(from, to string) (string, string, error) {
	if _, err := core.ParseKnowledgeTimeBoundary(from); err != nil {
		return "", "", errors.New("valid_time.start must be RFC 3339")
	}
	if _, err := core.ParseKnowledgeTimeBoundary(to); err != nil {
		return "", "", errors.New("valid_time.end must be RFC 3339")
	}
	canonicalFrom, canonicalTo, err := core.CanonicalKnowledgeInterval(from, to)
	if err != nil {
		return "", "", errors.New("valid_time.start must not be after valid_time.end")
	}
	return canonicalFrom, canonicalTo, nil
}

func validateCurationTypedLiteral(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil || len(fields) != 6 {
		return errors.New("typed literal must contain lexical_form, datatype, language, unit, si_value, and si_unit")
	}
	for _, key := range []string{"lexical_form", "datatype", "language", "unit", "si_value", "si_unit"} {
		if _, exists := fields[key]; !exists {
			return errors.New("typed literal must contain lexical_form, datatype, language, unit, si_value, and si_unit")
		}
	}
	var literal core.KnowledgeTypedLiteral
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&literal); err != nil {
		return errors.New("typed literal must use lexical_form, datatype, language, unit, si_value, and si_unit only")
	}
	if err := literal.Validate(); err != nil {
		return err
	}
	return nil
}

func validateCurationQualifiers(value any) error {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var qualifiers map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &qualifiers); err != nil || qualifiers == nil {
		return errors.New("qualifiers must be a JSON object")
	}
	for predicate, raw := range qualifiers {
		if strings.TrimSpace(predicate) == "" {
			return errors.New("qualifier predicate cannot be empty")
		}
		var qualifier struct {
			EntityID string          `json:"entity_id"`
			Literal  json.RawMessage `json:"literal"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&qualifier); err != nil {
			return fmt.Errorf("qualifier %s must contain entity_id or literal", predicate)
		}
		hasLiteral := len(qualifier.Literal) != 0 && string(qualifier.Literal) != "null"
		if (strings.TrimSpace(qualifier.EntityID) == "") == !hasLiteral {
			return fmt.Errorf("qualifier %s requires exactly one entity_id or literal", predicate)
		}
		if hasLiteral {
			if err := validateCurationTypedLiteral(qualifier.Literal); err != nil {
				return fmt.Errorf("qualifier %s literal: %w", predicate, err)
			}
		}
	}
	return nil
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func nullableInt64(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func normalizeKnowledgeName(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}
func textFrom(value map[string]any, key string) string {
	result, _ := value[key].(string)
	return strings.TrimSpace(result)
}
func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if stringsValue, ok := value.([]string); ok {
			return stringsValue
		}
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
}
func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func (service *Service) generationNQuads(ctx context.Context, projectID, generationID, ontologyID string) ([]byte, int, error) {
	return service.DB.KnowledgeNQuads(ctx, projectID, generationID, ontologyID)
}

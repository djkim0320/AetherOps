package store

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

	"github.com/djkim0320/AetherOps/internal/core"
)

const (
	storeRDFNS  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
	storeRDFSNS = "http://www.w3.org/2000/01/rdf-schema#"
	storeOWLNS  = "http://www.w3.org/2002/07/owl#"
	storeXSDNS  = "http://www.w3.org/2001/XMLSchema#"
)

type storeOntologyTerm struct {
	key, iri, kind, label, description, domainKey, rangeKey string
	functional                                              bool
}

type knowledgeRDFQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type KnowledgeBlobReader interface {
	ReadVerified(string) ([]byte, error)
}

type KnowledgeOntologyReceipt struct {
	OntologyID      string `json:"ontology_id"`
	CanonicalSHA256 string `json:"canonical_sha256"`
}

type KnowledgeSnapshotReceipt struct {
	ID            string `json:"id"`
	BlobHash      string `json:"blob_hash"`
	DatasetSHA256 string `json:"dataset_sha256"`
	TripleCount   int    `json:"triple_count"`
}

// KnowledgeGenerationOntologyReceipt resolves the immutable canonical
// ontology digest actually referenced by a project-isolated generation.
func (db *DB) KnowledgeGenerationOntologyReceipt(ctx context.Context, projectID, generationID string) (KnowledgeOntologyReceipt, error) {
	if projectID == "" || generationID == "" {
		return KnowledgeOntologyReceipt{}, errors.New("knowledge project and generation are required")
	}
	var receipt KnowledgeOntologyReceipt
	err := db.sql.QueryRowContext(ctx, `
SELECT o.id,o.canonical_sha256
FROM knowledge_generations g
JOIN ontology_versions o ON o.id=g.ontology_id
WHERE g.project_id=? AND g.id=? AND (o.project_id IS NULL OR o.project_id=g.project_id)`,
		projectID, generationID).Scan(&receipt.OntologyID, &receipt.CanonicalSHA256)
	if err != nil {
		return KnowledgeOntologyReceipt{}, err
	}
	if !validSHA256(receipt.CanonicalSHA256) {
		return KnowledgeOntologyReceipt{}, errors.New("knowledge generation ontology has an invalid canonical SHA-256")
	}
	return receipt, nil
}

// KnowledgeSnapshotReceipt requires exactly one canonical N-Quads receipt for
// every readable generation, including an ontology-only empty project graph.
func (db *DB) KnowledgeSnapshotReceipt(ctx context.Context, projectID, generationID string) (KnowledgeSnapshotReceipt, error) {
	if projectID == "" || generationID == "" {
		return KnowledgeSnapshotReceipt{}, errors.New("knowledge project and generation are required")
	}
	var receipt KnowledgeSnapshotReceipt
	var count int
	err := db.sql.QueryRowContext(ctx, `
SELECT COUNT(*),COALESCE(MAX(id),''),COALESCE(MAX(blob_hash),''),
       COALESCE(MAX(dataset_sha256),''),COALESCE(MAX(triple_count),0)
FROM knowledge_rdf_snapshots
WHERE project_id=? AND generation_id=? AND format='n-quads'`, projectID, generationID).Scan(
		&count, &receipt.ID, &receipt.BlobHash, &receipt.DatasetSHA256, &receipt.TripleCount,
	)
	if err != nil {
		return KnowledgeSnapshotReceipt{}, err
	}
	if count != 1 || receipt.ID == "" || receipt.BlobHash == "" ||
		receipt.BlobHash != receipt.DatasetSHA256 || !validSHA256(receipt.BlobHash) || receipt.TripleCount < 0 {
		return KnowledgeSnapshotReceipt{}, fmt.Errorf("knowledge generation %s has no unique content-addressed N-Quads snapshot", generationID)
	}
	return receipt, nil
}

// KnowledgeNQuads deterministically reconstructs the canonical local RDF
// snapshot directly from the authoritative generation projection.
func (db *DB) KnowledgeNQuads(ctx context.Context, projectID, generationID, ontologyID string) ([]byte, int, error) {
	return buildKnowledgeNQuads(ctx, db.sql, projectID, generationID, ontologyID)
}

// VerifyKnowledgeSnapshot binds the immutable SQLite projection, its canonical
// N-Quads receipt, and the actual CAS bytes before any run or SPARQL read.
func (db *DB) VerifyKnowledgeSnapshot(ctx context.Context, projectID, generationID string, reader KnowledgeBlobReader) error {
	generation, err := db.KnowledgeGeneration(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	if generation.State != KnowledgeReady && generation.State != KnowledgeRetired {
		return fmt.Errorf("knowledge generation %s is not readable: %s", generationID, generation.State)
	}
	receipt, err := db.KnowledgeSnapshotReceipt(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	if reader == nil {
		return fmt.Errorf("knowledge CAS reader is required")
	}
	expected, expectedTriples, err := db.KnowledgeNQuads(ctx, projectID, generationID, generation.OntologyID)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(expected)
	if hex.EncodeToString(sum[:]) != receipt.DatasetSHA256 || expectedTriples != receipt.TripleCount {
		return fmt.Errorf("knowledge generation %s snapshot receipt does not match its projection", generationID)
	}
	actual, err := reader.ReadVerified(receipt.BlobHash)
	if err != nil {
		return fmt.Errorf("read knowledge generation %s snapshot: %w", generationID, err)
	}
	if string(actual) != string(expected) {
		return fmt.Errorf("knowledge generation %s CAS snapshot differs from its projection", generationID)
	}
	return nil
}

func buildKnowledgeNQuads(ctx context.Context, queryer knowledgeRDFQueryer, projectID, generationID, ontologyID string) ([]byte, int, error) {
	termIRIs := map[string]string{}
	terms := []storeOntologyTerm{}
	rows, err := queryer.QueryContext(ctx, `
SELECT term_key,iri,kind,label,description,domain_key,range_key,functional FROM ontology_terms
WHERE ontology_id=? OR ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
ORDER BY CASE WHEN ontology_id=? THEN 0 ELSE 1 END,term_key`, ontologyID, ontologyID, ontologyID)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var term storeOntologyTerm
		if err := rows.Scan(&term.key, &term.iri, &term.kind, &term.label, &term.description, &term.domainKey, &term.rangeKey, &term.functional); err != nil {
			rows.Close()
			return nil, 0, err
		}
		if _, exists := termIRIs[term.key]; !exists {
			termIRIs[term.key] = term.iri
			terms = append(terms, term)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	lines := map[string]struct{}{}
	for _, term := range terms {
		subject := "<" + storeEscapeIRI(term.iri) + ">"
		kindIRI, err := storeOntologyKindIRI(term.kind)
		if err != nil {
			return nil, 0, fmt.Errorf("ontology term %s: %w", term.key, err)
		}
		lines[subject+" <"+storeRDFNS+"type> <"+kindIRI+"> .\n"] = struct{}{}
		if term.label != "" {
			lines[subject+" <"+storeRDFSNS+"label> "+storeQuoteRDF(term.label)+" .\n"] = struct{}{}
		}
		if term.description != "" {
			lines[subject+" <"+storeRDFSNS+"comment> "+storeQuoteRDF(term.description)+" .\n"] = struct{}{}
		}
		if term.domainKey != "" {
			domainIRI, err := storeResolveTermIRI(termIRIs, term.domainKey)
			if err != nil {
				return nil, 0, fmt.Errorf("ontology term %s domain: %w", term.key, err)
			}
			lines[subject+" <"+storeRDFSNS+"domain> <"+storeEscapeIRI(domainIRI)+"> .\n"] = struct{}{}
		}
		if term.rangeKey != "" {
			rangeIRI, err := storeResolveTermIRI(termIRIs, term.rangeKey)
			if err != nil {
				return nil, 0, fmt.Errorf("ontology term %s range: %w", term.key, err)
			}
			lines[subject+" <"+storeRDFSNS+"range> <"+storeEscapeIRI(rangeIRI)+"> .\n"] = struct{}{}
		}
		if term.functional {
			lines[subject+" <"+storeRDFNS+"type> <"+storeOWLNS+"FunctionalProperty> .\n"] = struct{}{}
		}
	}
	if err := storeAppendOntologyAxioms(ctx, queryer, ontologyID, termIRIs, lines); err != nil {
		return nil, 0, err
	}
	rows, err = queryer.QueryContext(ctx, `
SELECT id,class_key,canonical_name FROM knowledge_entities
WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, generationID)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var entityID, classKey, name string
		if err := rows.Scan(&entityID, &classKey, &name); err != nil {
			rows.Close()
			return nil, 0, err
		}
		classIRI := termIRIs[classKey]
		if classIRI == "" {
			rows.Close()
			return nil, 0, fmt.Errorf("entity %s uses unknown ontology class %s", entityID, classKey)
		}
		subject := "<" + storeEscapeIRI(storeEntityIRI(projectID, entityID)) + ">"
		lines[subject+" <"+storeRDFNS+"type> <"+storeEscapeIRI(classIRI)+"> .\n"] = struct{}{}
		lines[subject+" <"+storeRDFSNS+"label> "+storeQuoteRDF(name)+" .\n"] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	rows, err = queryer.QueryContext(ctx, `
SELECT entity_id,class_key FROM knowledge_type_inferences
WHERE project_id=? AND generation_id=? AND status='accepted'
ORDER BY entity_id,class_key`, projectID, generationID)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var entityID, classKey string
		if err := rows.Scan(&entityID, &classKey); err != nil {
			rows.Close()
			return nil, 0, err
		}
		classIRI := termIRIs[classKey]
		if classIRI == "" {
			rows.Close()
			return nil, 0, fmt.Errorf("inferred entity type %s uses unknown ontology class %s", entityID, classKey)
		}
		subject := "<" + storeEscapeIRI(storeEntityIRI(projectID, entityID)) + ">"
		lines[subject+" <"+storeRDFNS+"type> <"+storeEscapeIRI(classIRI)+"> .\n"] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	rows, err = queryer.QueryContext(ctx, `
SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),literal_json,
       qualifiers_json,polarity,status,COALESCE(valid_from,''),COALESCE(valid_to,'')
FROM knowledge_assertions
WHERE project_id=? AND generation_id=? AND status IN('accepted','disputed') ORDER BY id`, projectID, generationID)
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var assertionID, subjectID, predicateKey, objectID, literal, qualifiers, polarity, status, validFrom, validTo string
		if err := rows.Scan(&assertionID, &subjectID, &predicateKey, &objectID, &literal, &qualifiers, &polarity, &status, &validFrom, &validTo); err != nil {
			rows.Close()
			return nil, 0, err
		}
		predicateIRI := termIRIs[predicateKey]
		if predicateIRI == "" {
			rows.Close()
			return nil, 0, fmt.Errorf("assertion %s uses unknown ontology predicate %s", assertionID, predicateKey)
		}
		subject := "<" + storeEscapeIRI(storeEntityIRI(projectID, subjectID)) + ">"
		object := "<" + storeEscapeIRI(storeEntityIRI(projectID, objectID)) + ">"
		var typedLiteral core.KnowledgeTypedLiteral
		if objectID == "" {
			object, typedLiteral, err = storeRenderKnowledgeLiteral(literal)
			if err != nil {
				rows.Close()
				return nil, 0, fmt.Errorf("assertion %s literal: %w", assertionID, err)
			}
		}
		assertionSubject := "<" + storeEscapeIRI(storeAssertionIRI(projectID, assertionID)) + ">"
		lines[assertionSubject+" <"+storeRDFNS+"type> <urn:aetherops:Assertion> .\n"] = struct{}{}
		lines[assertionSubject+" <"+storeRDFNS+"subject> "+subject+" .\n"] = struct{}{}
		lines[assertionSubject+" <"+storeRDFNS+"predicate> <"+storeEscapeIRI(predicateIRI)+"> .\n"] = struct{}{}
		lines[assertionSubject+" <"+storeRDFNS+"object> "+object+" .\n"] = struct{}{}
		lines[assertionSubject+" <urn:aetherops:qualifiers> "+storeQuoteRDF(qualifiers)+"^^<"+storeRDFNS+"JSON> .\n"] = struct{}{}
		lines[assertionSubject+" <urn:aetherops:polarity> "+storeQuoteRDF(polarity)+" .\n"] = struct{}{}
		lines[assertionSubject+" <urn:aetherops:status> "+storeQuoteRDF(status)+" .\n"] = struct{}{}
		if polarity == "affirmed" && status == "accepted" {
			lines[subject+" <"+storeEscapeIRI(predicateIRI)+"> "+object+" .\n"] = struct{}{}
		}
		if objectID == "" {
			lines[assertionSubject+" <urn:aetherops:lexicalForm> "+storeQuoteRDF(typedLiteral.LexicalForm)+" .\n"] = struct{}{}
			lines[assertionSubject+" <urn:aetherops:sourceDatatype> "+storeQuoteRDF(typedLiteral.Datatype)+" .\n"] = struct{}{}
			if typedLiteral.Unit != "" {
				lines[assertionSubject+" <urn:aetherops:unit> "+storeQuoteRDF(typedLiteral.Unit)+" .\n"] = struct{}{}
				lines[assertionSubject+" <urn:aetherops:siValue> "+storeQuoteRDF(typedLiteral.SIValue)+"^^<"+storeXSDNS+"decimal> .\n"] = struct{}{}
				lines[assertionSubject+" <urn:aetherops:siUnit> "+storeQuoteRDF(typedLiteral.SIUnit)+" .\n"] = struct{}{}
			}
		}
		if validFrom != "" {
			lines[assertionSubject+" <urn:aetherops:validFrom> "+storeQuoteRDF(validFrom)+"^^<"+storeXSDNS+"dateTime> .\n"] = struct{}{}
		}
		if validTo != "" {
			lines[assertionSubject+" <urn:aetherops:validTo> "+storeQuoteRDF(validTo)+"^^<"+storeXSDNS+"dateTime> .\n"] = struct{}{}
		}
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	ordered := make([]string, 0, len(lines))
	for line := range lines {
		ordered = append(ordered, line)
	}
	sort.Strings(ordered)
	return []byte(strings.Join(ordered, "")), len(ordered), nil
}

func storeAppendOntologyAxioms(ctx context.Context, queryer knowledgeRDFQueryer, ontologyID string, termIRIs map[string]string, lines map[string]struct{}) error {
	rows, err := queryer.QueryContext(ctx, `
SELECT axiom_type,subject_key,predicate_key,object_key,literal_json
FROM ontology_axioms
WHERE ontology_id=? OR ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
ORDER BY ontology_id,id`, ontologyID, ontologyID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, subjectKey, predicateKey, objectKey, literalJSON string
		if err := rows.Scan(&kind, &subjectKey, &predicateKey, &objectKey, &literalJSON); err != nil {
			return err
		}
		subjectIRI, err := storeResolveTermIRI(termIRIs, subjectKey)
		if err != nil {
			return fmt.Errorf("ontology axiom %s subject: %w", kind, err)
		}
		subject := "<" + storeEscapeIRI(subjectIRI) + ">"
		var predicate, object string
		switch kind {
		case "subclass_of":
			predicate = storeRDFSNS + "subClassOf"
			object, err = storeAxiomIRIObject(termIRIs, objectKey)
		case "subproperty_of":
			predicate = storeRDFSNS + "subPropertyOf"
			object, err = storeAxiomIRIObject(termIRIs, objectKey)
		case "domain":
			predicate = storeRDFSNS + "domain"
			object, err = storeAxiomIRIObject(termIRIs, objectKey)
		case "range":
			predicate = storeRDFSNS + "range"
			object, err = storeAxiomIRIObject(termIRIs, objectKey)
		case "inverse_of":
			predicate = storeOWLNS + "inverseOf"
			object, err = storeAxiomIRIObject(termIRIs, objectKey)
		case "symmetric":
			predicate, object = storeRDFNS+"type", "<"+storeOWLNS+"SymmetricProperty>"
		case "transitive":
			predicate, object = storeRDFNS+"type", "<"+storeOWLNS+"TransitiveProperty>"
		case "functional":
			predicate, object = storeRDFNS+"type", "<"+storeOWLNS+"FunctionalProperty>"
		case "annotation":
			predicate, err = storeResolveTermIRI(termIRIs, predicateKey)
			if err == nil {
				object, err = storeRenderOntologyAnnotation(literalJSON)
			}
		default:
			return fmt.Errorf("unsupported stored ontology axiom %q", kind)
		}
		if err != nil {
			return fmt.Errorf("ontology axiom %s: %w", kind, err)
		}
		lines[subject+" <"+storeEscapeIRI(predicate)+"> "+object+" .\n"] = struct{}{}
	}
	return rows.Err()
}

func storeOntologyKindIRI(kind string) (string, error) {
	switch kind {
	case "class":
		return storeOWLNS + "Class", nil
	case "object_property":
		return storeOWLNS + "ObjectProperty", nil
	case "datatype_property":
		return storeOWLNS + "DatatypeProperty", nil
	case "annotation_property":
		return storeOWLNS + "AnnotationProperty", nil
	case "individual":
		return storeOWLNS + "NamedIndividual", nil
	default:
		return "", fmt.Errorf("unsupported ontology term kind %q", kind)
	}
}

func storeResolveTermIRI(termIRIs map[string]string, keyOrIRI string) (string, error) {
	if iri := termIRIs[keyOrIRI]; iri != "" {
		return iri, nil
	}
	parsed, err := url.Parse(keyOrIRI)
	if err == nil && parsed.IsAbs() && !strings.ContainsAny(keyOrIRI, "<> \t\r\n") {
		return keyOrIRI, nil
	}
	return "", fmt.Errorf("unknown ontology term %q", keyOrIRI)
}

func storeAxiomIRIObject(termIRIs map[string]string, keyOrIRI string) (string, error) {
	iri, err := storeResolveTermIRI(termIRIs, keyOrIRI)
	if err != nil {
		return "", err
	}
	return "<" + storeEscapeIRI(iri) + ">", nil
}

func storeRenderOntologyAnnotation(raw string) (string, error) {
	var value struct {
		Value, Language, Datatype string
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil || value.Value == "" {
		return "", errors.New("invalid ontology annotation literal")
	}
	if value.Language != "" {
		return storeQuoteRDF(value.Value) + "@" + value.Language, nil
	}
	if value.Datatype != "" {
		datatype, err := storeResolveTermIRI(nil, value.Datatype)
		if err != nil {
			return "", err
		}
		return storeQuoteRDF(value.Value) + "^^<" + storeEscapeIRI(datatype) + ">", nil
	}
	return storeQuoteRDF(value.Value), nil
}

func storeRenderKnowledgeLiteral(raw string) (string, core.KnowledgeTypedLiteral, error) {
	var literal core.KnowledgeTypedLiteral
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err != nil || !storeHasExactLiteralFields(fields) {
		return "", literal, errors.New("typed literal must contain lexical_form, datatype, language, unit, si_value, and si_unit exactly once")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&literal); err != nil {
		return "", literal, fmt.Errorf("decode typed literal: %w", err)
	}
	if err := literal.Validate(); err != nil {
		return "", literal, err
	}
	if literal.Language != "" {
		return storeQuoteRDF(literal.LexicalForm) + "@" + literal.Language, literal, nil
	}
	datatype := literal.Datatype
	if literal.Unit != "" {
		datatype = storeXSDNS + "decimal"
	} else {
		var err error
		datatype, err = storeKnowledgeDatatypeIRI(datatype)
		if err != nil {
			return "", literal, err
		}
	}
	return storeQuoteRDF(literal.LexicalForm) + "^^<" + storeEscapeIRI(datatype) + ">", literal, nil
}

func storeHasExactLiteralFields(fields map[string]json.RawMessage) bool {
	if len(fields) != 6 {
		return false
	}
	for _, key := range []string{"lexical_form", "datatype", "language", "unit", "si_value", "si_unit"} {
		if _, exists := fields[key]; !exists {
			return false
		}
	}
	return true
}

func storeKnowledgeDatatypeIRI(datatype string) (string, error) {
	aliases := map[string]string{
		"string": "string", "number": "decimal", "decimal": "decimal", "double": "double", "float": "float",
		"integer": "integer", "int": "int", "boolean": "boolean", "time": "dateTime", "datetime": "dateTime", "date": "date",
		"json": "json",
	}
	if local := aliases[strings.ToLower(strings.TrimSpace(datatype))]; local != "" {
		if local == "json" {
			return storeRDFNS + "JSON", nil
		}
		return storeXSDNS + local, nil
	}
	return storeResolveTermIRI(nil, datatype)
}

func validateKnowledgeSnapshotBinding(ctx context.Context, tx *sql.Tx, projectID, generationID, ontologyID string, _ knowledgeCounts) error {
	var blobHash, datasetHash string
	var tripleCount, snapshots int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*),COALESCE(MAX(blob_hash),''),COALESCE(MAX(dataset_sha256),''),COALESCE(MAX(triple_count),0)
FROM knowledge_rdf_snapshots
WHERE project_id=? AND generation_id=? AND format='n-quads'`, projectID, generationID).Scan(
		&snapshots, &blobHash, &datasetHash, &tripleCount,
	); err != nil {
		return err
	}
	if snapshots != 1 || blobHash == "" || blobHash != datasetHash {
		return fmt.Errorf("knowledge generation requires exactly one content-addressed canonical N-Quads snapshot")
	}
	expected, expectedTriples, err := buildKnowledgeNQuads(ctx, tx, projectID, generationID, ontologyID)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(expected)
	if hex.EncodeToString(sum[:]) != datasetHash || expectedTriples != tripleCount {
		return fmt.Errorf("knowledge RDF snapshot does not match the authoritative generation projection")
	}
	return nil
}

func storeEntityIRI(projectID, entityID string) string {
	return "urn:aetherops:project:" + base64.RawURLEncoding.EncodeToString([]byte(projectID)) + ":entity:" + url.PathEscape(entityID)
}

func storeAssertionIRI(projectID, assertionID string) string {
	return "urn:aetherops:project:" + base64.RawURLEncoding.EncodeToString([]byte(projectID)) + ":assertion:" + url.PathEscape(assertionID)
}

func storeEscapeIRI(value string) string {
	return strings.NewReplacer(">", "%3E", "<", "%3C", " ", "%20").Replace(value)
}

func storeQuoteRDF(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

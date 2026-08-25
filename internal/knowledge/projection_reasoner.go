package knowledge

import (
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

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

type projectionRule struct {
	OntologyID string
	AxiomID    string
	Kind       string
	From       string
	To         string
	Reverse    bool
}

type projectionStatement struct {
	ID           string
	Subject      string
	Predicate    string
	ObjectEntity string
	Literal      string
	Qualifiers   string
	Polarity     string
	Status       string
	ValidFrom    *time.Time
	ValidTo      *time.Time
	Confidence   float64
}

type projectionEntityClass struct {
	EntityID    string
	ClassKey    string
	InferenceID string
}

func (value projectionEntityClass) key() string {
	return value.EntityID + "\x00" + value.ClassKey
}

func (value projectionStatement) key() string {
	return strings.Join([]string{
		value.Subject, value.Predicate, value.ObjectEntity, value.Literal,
		value.Qualifiers, optionalReasoningTime(value.ValidFrom), optionalReasoningTime(value.ValidTo),
	}, "\x00")
}

func (value projectionStatement) objectKey() string {
	if value.ObjectEntity != "" {
		return "entity\x00" + value.ObjectEntity
	}
	return "literal\x00" + value.Literal
}

// materializeOntologyProjection always derives a fresh proof projection from
// asserted rows. Old inferred conclusions are deliberately not copied between
// generations, so an ontology or curation change cannot leave stale proofs.
func (service *Service) materializeOntologyProjection(ctx context.Context, projectID, generationID string) error {
	ontologyID, rules, functional, err := service.loadProjectionRules(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	statements, evidence, err := service.loadProjectionStatements(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	entityClasses, err := service.loadProjectionEntityClasses(ctx, projectID, generationID)
	if err != nil {
		return err
	}
	projection, allStatements, err := deriveKnowledgeProjection(statements, evidence, entityClasses, rules, ontologyID, defaultInferenceLimit)
	if err != nil {
		return err
	}
	conflicts := detectProjectionConflicts(allStatements, functional)
	remaining, err := service.reconcileProjectionConflicts(ctx, projectID, generationID, conflicts)
	if err != nil {
		return err
	}
	projection.Conflicts = remaining
	if len(projection.Assertions) == 0 && len(projection.Conflicts) == 0 && len(projection.TypeInferences) == 0 {
		return nil
	}
	return service.DB.AppendKnowledgeProjection(ctx, projectID, generationID, projection)
}

func (service *Service) loadProjectionRules(ctx context.Context, projectID, generationID string) (string, []projectionRule, map[string]bool, error) {
	var ontologyID string
	if err := service.DB.SQL().QueryRowContext(ctx, `
SELECT ontology_id FROM knowledge_generations WHERE project_id=? AND id=? AND state='building'`,
		projectID, generationID).Scan(&ontologyID); err != nil {
		return "", nil, nil, err
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT a.ontology_id,a.id,a.axiom_type,a.subject_key,a.object_key
FROM ontology_axioms a
WHERE a.axiom_type IN('subclass_of','subproperty_of','domain','range','inverse_of','symmetric','transitive')
AND (a.ontology_id=? OR (
 a.ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
 AND NOT EXISTS(SELECT 1 FROM ontology_terms own WHERE own.ontology_id=? AND own.term_key=a.subject_key)
))
ORDER BY CASE WHEN a.ontology_id=? THEN 0 ELSE 1 END,a.id`,
		ontologyID, ontologyID, ontologyID, ontologyID)
	if err != nil {
		return "", nil, nil, err
	}
	var rules []projectionRule
	for rows.Next() {
		var rule projectionRule
		if err := rows.Scan(&rule.OntologyID, &rule.AxiomID, &rule.Kind, &rule.From, &rule.To); err != nil {
			rows.Close()
			return "", nil, nil, err
		}
		switch rule.Kind {
		case "subclass_of", "domain", "range":
			if rule.From != "" && rule.To != "" {
				rules = append(rules, rule)
			}
		case "subproperty_of":
			if rule.From != "" && rule.To != "" {
				rules = append(rules, rule)
			}
		case "inverse_of":
			if rule.From != "" && rule.To != "" {
				rule.Reverse = true
				rules = append(rules, rule, projectionRule{
					OntologyID: rule.OntologyID, AxiomID: rule.AxiomID, Kind: rule.Kind,
					From: rule.To, To: rule.From, Reverse: true,
				})
			}
		case "symmetric":
			rule.To, rule.Reverse = rule.From, true
			rules = append(rules, rule)
		case "transitive":
			rule.To = rule.From
			rules = append(rules, rule)
		}
	}
	if err := rows.Close(); err != nil {
		return "", nil, nil, err
	}
	sort.Slice(rules, func(i, j int) bool {
		left := rules[i].AxiomID + "\x00" + rules[i].From + "\x00" + rules[i].To
		right := rules[j].AxiomID + "\x00" + rules[j].From + "\x00" + rules[j].To
		return left < right
	})
	functional := map[string]bool{}
	termRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT t.term_key FROM ontology_terms t
WHERE t.functional=1 AND (t.ontology_id=? OR (
 t.ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
 AND NOT EXISTS(SELECT 1 FROM ontology_terms own WHERE own.ontology_id=? AND own.term_key=t.term_key)
))`, ontologyID, ontologyID, ontologyID)
	if err != nil {
		return "", nil, nil, err
	}
	for termRows.Next() {
		var key string
		if err := termRows.Scan(&key); err != nil {
			termRows.Close()
			return "", nil, nil, err
		}
		functional[key] = true
	}
	if err := termRows.Close(); err != nil {
		return "", nil, nil, err
	}
	return ontologyID, rules, functional, nil
}

func (service *Service) loadProjectionEntityClasses(ctx context.Context, projectID, generationID string) ([]projectionEntityClass, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,class_key FROM knowledge_entities
WHERE project_id=? AND generation_id=? ORDER BY id`, projectID, generationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []projectionEntityClass
	for rows.Next() {
		var value projectionEntityClass
		if err := rows.Scan(&value.EntityID, &value.ClassKey); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func (service *Service) loadProjectionStatements(ctx context.Context, projectID, generationID string) ([]projectionStatement, map[string][]store.KnowledgeAssertionEvidenceRecord, error) {
	rows, err := service.DB.SQL().QueryContext(ctx, `
SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),literal_json,
 qualifiers_json,polarity,status,COALESCE(valid_from,''),COALESCE(valid_to,''),confidence
FROM knowledge_assertions
WHERE project_id=? AND generation_id=?
AND NOT EXISTS(SELECT 1 FROM knowledge_inferences i
 WHERE i.project_id=knowledge_assertions.project_id
 AND i.generation_id=knowledge_assertions.generation_id
 AND i.conclusion_assertion_id=knowledge_assertions.id)
ORDER BY id`, projectID, generationID)
	if err != nil {
		return nil, nil, err
	}
	var statements []projectionStatement
	for rows.Next() {
		var value projectionStatement
		var from, to string
		if err := rows.Scan(&value.ID, &value.Subject, &value.Predicate, &value.ObjectEntity,
			&value.Literal, &value.Qualifiers, &value.Polarity, &value.Status,
			&from, &to, &value.Confidence); err != nil {
			rows.Close()
			return nil, nil, err
		}
		value.Qualifiers, err = canonicalReasoningJSON(value.Qualifiers)
		if err != nil {
			rows.Close()
			return nil, nil, fmt.Errorf("assertion %s qualifiers: %w", value.ID, err)
		}
		if value.Literal != "" {
			value.Literal, err = canonicalReasoningJSON(value.Literal)
			if err != nil {
				rows.Close()
				return nil, nil, fmt.Errorf("assertion %s literal: %w", value.ID, err)
			}
		}
		if value.ValidFrom, err = parseReasoningTime(from); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if value.ValidTo, err = parseReasoningTime(to); err != nil {
			rows.Close()
			return nil, nil, err
		}
		statements = append(statements, value)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	evidenceRows, err := service.DB.SQL().QueryContext(ctx, `
SELECT e.assertion_id,e.evidence_kind,e.blob_hash,COALESCE(e.chunk_id,''),e.claim_id,e.source_id,
 e.start_byte,e.end_byte,e.locator_json,e.evidence_sha256
FROM knowledge_assertion_evidence e
WHERE e.project_id=? AND e.generation_id=? ORDER BY e.assertion_id,e.evidence_kind,e.blob_hash,e.evidence_sha256`,
		projectID, generationID)
	if err != nil {
		return nil, nil, err
	}
	evidence := map[string][]store.KnowledgeAssertionEvidenceRecord{}
	for evidenceRows.Next() {
		var assertionID string
		var record store.KnowledgeAssertionEvidenceRecord
		var start, end sql.NullInt64
		var locator string
		if err := evidenceRows.Scan(&assertionID, &record.EvidenceKind, &record.BlobHash,
			&record.ChunkID, &record.ClaimID, &record.SourceID, &start, &end,
			&locator, &record.EvidenceSHA256); err != nil {
			evidenceRows.Close()
			return nil, nil, err
		}
		record.Locator = json.RawMessage(locator)
		if start.Valid {
			value := int(start.Int64)
			record.StartByte = &value
		}
		if end.Valid {
			value := int(end.Int64)
			record.EndByte = &value
		}
		evidence[assertionID] = append(evidence[assertionID], record)
	}
	if err := evidenceRows.Close(); err != nil {
		return nil, nil, err
	}
	return statements, evidence, nil
}

func deriveKnowledgeProjection(asserted []projectionStatement, evidence map[string][]store.KnowledgeAssertionEvidenceRecord, entityClasses []projectionEntityClass, rules []projectionRule, ontologyID string, limit int) (store.KnowledgeProjection, []projectionStatement, error) {
	if limit <= 0 {
		limit = defaultInferenceLimit
	}
	known := map[string]projectionStatement{}
	byID := map[string]projectionStatement{}
	for _, value := range asserted {
		if value.ID == "" || value.Subject == "" || value.Predicate == "" {
			return store.KnowledgeProjection{}, nil, errors.New("assertions require id, subject, and predicate")
		}
		known[value.key()], byID[value.ID] = value, value
	}
	var projection store.KnowledgeProjection
	add := func(candidate projectionStatement, rule projectionRule, parents ...string) (bool, error) {
		key := candidate.key()
		if _, exists := known[key]; exists {
			return false, nil
		}
		if len(projection.Inferences) >= limit {
			return false, errors.New("ontology inference limit exceeded")
		}
		sort.Strings(parents)
		candidate.ID = deterministicInferenceID(rule.AxiomID, key, parents)
		if _, collision := byID[candidate.ID]; collision {
			return false, fmt.Errorf("deterministic inference id collision %s", candidate.ID)
		}
		candidate.Status, candidate.Polarity = "accepted", "affirmed"
		candidateEvidence := inheritProjectionEvidence(candidate.ID, parents, evidence)
		if len(candidateEvidence) == 0 {
			return false, fmt.Errorf("inference %s has no inherited evidence", candidate.ID)
		}
		known[key], byID[candidate.ID], evidence[candidate.ID] = candidate, candidate, candidateEvidence
		literal := json.RawMessage(nil)
		if candidate.Literal != "" {
			literal = json.RawMessage(candidate.Literal)
		}
		projection.Assertions = append(projection.Assertions, store.KnowledgeAssertionRecord{
			ID: candidate.ID, SubjectEntityID: candidate.Subject, PredicateKey: candidate.Predicate,
			ObjectEntityID: candidate.ObjectEntity, Literal: literal,
			Qualifiers: json.RawMessage(candidate.Qualifiers), Polarity: candidate.Polarity,
			ValidFrom: candidate.ValidFrom, ValidTo: candidate.ValidTo, Status: candidate.Status,
			Confidence: candidate.Confidence, AssertionKey: reasoningSHA256(key),
		})
		projection.Evidence = append(projection.Evidence, candidateEvidence...)
		projection.Inferences = append(projection.Inferences, store.KnowledgeInferenceRecord{
			ID: candidate.ID, ConclusionAssertionID: candidate.ID, OntologyID: rule.OntologyID,
			RuleAxiomID: rule.AxiomID, Status: "accepted",
		})
		for ordinal, parentID := range parents {
			projection.Proofs = append(projection.Proofs, store.KnowledgeInferenceProofRecord{
				InferenceID: candidate.ID, Ordinal: ordinal, PremiseAssertionID: parentID,
			})
		}
		return true, nil
	}
	for changed := true; changed; {
		changed = false
		current := sortedProjectionStatements(byID)
		for _, value := range current {
			if value.Status != "accepted" || value.Polarity != "affirmed" {
				continue
			}
			for _, rule := range rules {
				if (rule.Kind != "subproperty_of" && rule.Kind != "inverse_of" && rule.Kind != "symmetric") || rule.From != value.Predicate {
					continue
				}
				if rule.Kind != "subproperty_of" && value.ObjectEntity == "" {
					continue
				}
				candidate := value
				candidate.ID, candidate.Predicate = "", rule.To
				if rule.Reverse {
					candidate.Subject, candidate.ObjectEntity = value.ObjectEntity, value.Subject
				}
				added, err := add(candidate, rule, value.ID)
				if err != nil {
					return store.KnowledgeProjection{}, nil, err
				}
				changed = changed || added
			}
		}
		current = sortedProjectionStatements(byID)
		for _, rule := range rules {
			if rule.Kind != "transitive" {
				continue
			}
			for _, left := range current {
				if left.Status != "accepted" || left.Polarity != "affirmed" || left.Predicate != rule.From || left.ObjectEntity == "" {
					continue
				}
				for _, right := range current {
					if right.Status != "accepted" || right.Polarity != "affirmed" || right.Predicate != rule.From ||
						right.Subject != left.ObjectEntity || right.ObjectEntity == "" || right.Qualifiers != left.Qualifiers {
						continue
					}
					from, to := reasoningMaxStart(left.ValidFrom, right.ValidFrom), reasoningMinEnd(left.ValidTo, right.ValidTo)
					if from != nil && to != nil && from.After(*to) {
						continue
					}
					candidate := left
					candidate.ID, candidate.ObjectEntity, candidate.ValidFrom, candidate.ValidTo = "", right.ObjectEntity, from, to
					candidate.Confidence = minReasoningConfidence(left.Confidence, right.Confidence)
					added, err := add(candidate, rule, left.ID, right.ID)
					if err != nil {
						return store.KnowledgeProjection{}, nil, err
					}
					changed = changed || added
				}
			}
		}
	}
	allStatements := sortedProjectionStatements(byID)
	typeInferences, typeProofs, err := deriveKnowledgeTypeProjection(
		entityClasses, allStatements, rules, limit-len(projection.Inferences),
	)
	if err != nil {
		return store.KnowledgeProjection{}, nil, err
	}
	projection.TypeInferences = append(projection.TypeInferences, typeInferences...)
	projection.TypeProofs = append(projection.TypeProofs, typeProofs...)
	return projection, allStatements, nil
}

func deriveKnowledgeTypeProjection(
	explicit []projectionEntityClass,
	statements []projectionStatement,
	rules []projectionRule,
	limit int,
) ([]store.KnowledgeTypeInferenceRecord, []store.KnowledgeTypeInferenceProofRecord, error) {
	if limit < 0 {
		return nil, nil, errors.New("ontology inference limit exceeded")
	}
	known := make(map[string]projectionEntityClass, len(explicit))
	for _, value := range explicit {
		if value.EntityID == "" || value.ClassKey == "" {
			return nil, nil, errors.New("entity classifications require entity and class")
		}
		known[value.key()] = value
	}
	var inferences []store.KnowledgeTypeInferenceRecord
	var proofs []store.KnowledgeTypeInferenceProofRecord
	add := func(candidate projectionEntityClass, rule projectionRule, proof store.KnowledgeTypeInferenceProofRecord) (bool, error) {
		key := candidate.key()
		if _, exists := known[key]; exists {
			return false, nil
		}
		if len(inferences) >= limit {
			return false, errors.New("ontology inference limit exceeded")
		}
		parentID := proof.PremiseAssertionID
		if proof.PremiseKind == "entity_class" {
			parentID = "entity_class:" + proof.PremiseEntityID + ":" + proof.PremiseClassKey
		} else if proof.PremiseKind == "type_inference" {
			parentID = proof.PremiseTypeInferenceID
		}
		candidate.InferenceID = deterministicInferenceID(rule.AxiomID, "rdf:type\x00"+key, []string{parentID})
		known[key] = candidate
		inferences = append(inferences, store.KnowledgeTypeInferenceRecord{
			ID: candidate.InferenceID, EntityID: candidate.EntityID, ClassKey: candidate.ClassKey,
			OntologyID: rule.OntologyID, RuleAxiomID: rule.AxiomID, Status: "accepted",
		})
		proof.InferenceID = candidate.InferenceID
		proofs = append(proofs, proof)
		return true, nil
	}
	for _, statement := range statements {
		if statement.Status != "accepted" || statement.Polarity != "affirmed" {
			continue
		}
		for _, rule := range rules {
			var entityID string
			switch {
			case rule.Kind == "domain" && rule.From == statement.Predicate:
				entityID = statement.Subject
			case rule.Kind == "range" && rule.From == statement.Predicate && statement.ObjectEntity != "":
				entityID = statement.ObjectEntity
			default:
				continue
			}
			if _, err := add(projectionEntityClass{EntityID: entityID, ClassKey: rule.To}, rule,
				store.KnowledgeTypeInferenceProofRecord{Ordinal: 0, PremiseKind: "assertion", PremiseAssertionID: statement.ID}); err != nil {
				return nil, nil, err
			}
		}
	}
	for changed := true; changed; {
		changed = false
		current := make([]projectionEntityClass, 0, len(known))
		for _, value := range known {
			current = append(current, value)
		}
		sort.Slice(current, func(i, j int) bool {
			if current[i].EntityID == current[j].EntityID {
				return current[i].ClassKey < current[j].ClassKey
			}
			return current[i].EntityID < current[j].EntityID
		})
		for _, value := range current {
			for _, rule := range rules {
				if rule.Kind != "subclass_of" || rule.From != value.ClassKey {
					continue
				}
				proof := store.KnowledgeTypeInferenceProofRecord{Ordinal: 0}
				if value.InferenceID == "" {
					proof.PremiseKind, proof.PremiseEntityID, proof.PremiseClassKey = "entity_class", value.EntityID, value.ClassKey
				} else {
					proof.PremiseKind, proof.PremiseTypeInferenceID = "type_inference", value.InferenceID
				}
				added, err := add(projectionEntityClass{EntityID: value.EntityID, ClassKey: rule.To}, rule, proof)
				if err != nil {
					return nil, nil, err
				}
				changed = changed || added
			}
		}
	}
	sort.Slice(inferences, func(i, j int) bool { return inferences[i].ID < inferences[j].ID })
	sort.Slice(proofs, func(i, j int) bool {
		if proofs[i].InferenceID == proofs[j].InferenceID {
			return proofs[i].Ordinal < proofs[j].Ordinal
		}
		return proofs[i].InferenceID < proofs[j].InferenceID
	})
	return inferences, proofs, nil
}

func inheritProjectionEvidence(assertionID string, parents []string, evidence map[string][]store.KnowledgeAssertionEvidenceRecord) []store.KnowledgeAssertionEvidenceRecord {
	seen := map[string]bool{}
	var result []store.KnowledgeAssertionEvidenceRecord
	for _, parentID := range parents {
		for _, source := range evidence[parentID] {
			key := source.EvidenceKind + "\x00" + source.BlobHash + "\x00" + source.EvidenceSHA256
			if seen[key] {
				continue
			}
			seen[key] = true
			source.AssertionID = assertionID
			result = append(result, source)
		}
	}
	return result
}

func detectProjectionConflicts(statements []projectionStatement, functional map[string]bool) []store.KnowledgeConflictRecord {
	groups := map[string][]projectionStatement{}
	for _, value := range statements {
		if functional[value.Predicate] && value.Polarity == "affirmed" && (value.Status == "accepted" || value.Status == "disputed") {
			key := value.Subject + "\x00" + value.Predicate + "\x00" + value.Qualifiers
			groups[key] = append(groups[key], value)
		}
	}
	var conflicts []store.KnowledgeConflictRecord
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool { return group[i].ID < group[j].ID })
		for left := 0; left < len(group); left++ {
			for right := left + 1; right < len(group); right++ {
				if group[left].objectKey() == group[right].objectKey() || !reasoningIntervalsOverlap(group[left], group[right]) {
					continue
				}
				material := group[left].ID + "\x00" + group[right].ID + "\x00" + group[left].Predicate + "\x00" + group[left].Qualifiers
				conflicts = append(conflicts, store.KnowledgeConflictRecord{
					ID: "kconf_" + reasoningSHA256(material)[:32], LeftAssertionID: group[left].ID,
					RightAssertionID: group[right].ID,
					Reason:           "functional property has different values under identical qualifiers and overlapping validity",
					Status:           "open",
				})
			}
		}
	}
	sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].ID < conflicts[j].ID })
	return conflicts
}

func (service *Service) reconcileProjectionConflicts(ctx context.Context, projectID, generationID string, desired []store.KnowledgeConflictRecord) ([]store.KnowledgeConflictRecord, error) {
	desiredByPair := map[string]store.KnowledgeConflictRecord{}
	for _, value := range desired {
		desiredByPair[reasoningConflictPair(value.LeftAssertionID, value.RightAssertionID)] = value
	}
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT id,left_assertion_id,right_assertion_id FROM knowledge_conflicts WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return nil, err
	}
	type existingConflict struct{ id, left, right string }
	var existing []existingConflict
	for rows.Next() {
		var value existingConflict
		if err := rows.Scan(&value.id, &value.left, &value.right); err != nil {
			rows.Close()
			return nil, err
		}
		existing = append(existing, value)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, value := range existing {
		pair := reasoningConflictPair(value.left, value.right)
		if _, keep := desiredByPair[pair]; keep {
			delete(desiredByPair, pair)
			continue
		}
		if _, err := service.DB.SQL().ExecContext(ctx, `DELETE FROM knowledge_conflicts WHERE project_id=? AND generation_id=? AND id=?`, projectID, generationID, value.id); err != nil {
			return nil, err
		}
	}
	remaining := make([]store.KnowledgeConflictRecord, 0, len(desiredByPair))
	for _, value := range desiredByPair {
		remaining = append(remaining, value)
	}
	sort.Slice(remaining, func(i, j int) bool { return remaining[i].ID < remaining[j].ID })
	return remaining, nil
}

func (service *Service) rekeyKnowledgeAssertions(ctx context.Context, projectID, generationID string) error {
	rows, err := service.DB.SQL().QueryContext(ctx, `SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),literal_json,qualifiers_json,COALESCE(valid_from,''),COALESCE(valid_to,'') FROM knowledge_assertions WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	type update struct{ id, key, from, to string }
	var updates []update
	for rows.Next() {
		var id, subject, predicate, objectID, literal, qualifiers, from, to string
		if err := rows.Scan(&id, &subject, &predicate, &objectID, &literal, &qualifiers, &from, &to); err != nil {
			rows.Close()
			return err
		}
		qualifiers, err = canonicalReasoningJSON(qualifiers)
		if err != nil {
			rows.Close()
			return err
		}
		if literal != "" {
			literal, err = canonicalReasoningJSON(literal)
			if err != nil {
				rows.Close()
				return err
			}
		}
		from, to, err = core.CanonicalKnowledgeInterval(from, to)
		if err != nil {
			rows.Close()
			return fmt.Errorf("assertion %s validity: %w", id, err)
		}
		updates = append(updates, update{
			id: id, from: from, to: to,
			key: reasoningSHA256(strings.Join([]string{subject, predicate, objectID, literal, qualifiers, from, to}, "\x00")),
		})
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := service.DB.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, value := range updates {
		if _, err := tx.ExecContext(ctx, `UPDATE knowledge_assertions SET assertion_key=?,valid_from=NULLIF(?,''),valid_to=NULLIF(?,'') WHERE project_id=? AND generation_id=? AND id=?`, value.key, value.from, value.to, projectID, generationID, value.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func canonicalReasoningJSON(value string) (string, error) {
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(decoded)
	return string(encoded), err
}

func parseReasoningTime(value string) (*time.Time, error) {
	return core.ParseKnowledgeTimeBoundary(value)
}

func optionalReasoningTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return core.CanonicalKnowledgeTime(*value)
}

func sortedProjectionStatements(values map[string]projectionStatement) []projectionStatement {
	result := make([]projectionStatement, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func reasoningSHA256(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func reasoningMaxStart(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil || left.After(*right) {
		return left
	}
	return right
}

func reasoningMinEnd(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil || left.Before(*right) {
		return left
	}
	return right
}

func reasoningIntervalsOverlap(left, right projectionStatement) bool {
	from, to := reasoningMaxStart(left.ValidFrom, right.ValidFrom), reasoningMinEnd(left.ValidTo, right.ValidTo)
	return from == nil || to == nil || !from.After(*to)
}

func minReasoningConfidence(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

func reasoningConflictPair(left, right string) string {
	if right < left {
		left, right = right, left
	}
	return left + "\x00" + right
}

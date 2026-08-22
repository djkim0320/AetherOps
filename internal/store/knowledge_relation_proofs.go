package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/djkim0320/Aether-claw/internal/core"
)

type storedRelationInference struct {
	id, conclusionID, ontologyID, axiomID, status string
}

type storedRelationProof struct {
	ordinal   int
	premiseID string
}

type storedRelationAxiom struct {
	kind, subject, object string
}

type storedRelationAssertion struct {
	id, subject, predicate, object, literal, qualifiers string
	polarity, status, validFrom, validTo                string
	confidence                                          float64
}

func validateKnowledgeRelationInferenceProofs(ctx context.Context, tx *sql.Tx, projectID, generationID string) error {
	inferences := map[string]storedRelationInference{}
	byConclusion := map[string]string{}
	rows, err := tx.QueryContext(ctx, `
SELECT id,conclusion_assertion_id,ontology_id,rule_axiom_id,status
FROM knowledge_inferences WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var value storedRelationInference
		if err := rows.Scan(&value.id, &value.conclusionID, &value.ontologyID, &value.axiomID, &value.status); err != nil {
			rows.Close()
			return err
		}
		if prior, duplicate := byConclusion[value.conclusionID]; duplicate && prior != value.id {
			rows.Close()
			return fmt.Errorf("knowledge assertion %s has multiple inference records", value.conclusionID)
		}
		inferences[value.id], byConclusion[value.conclusionID] = value, value.id
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(inferences) == 0 {
		return nil
	}

	proofs := map[string][]storedRelationProof{}
	rows, err = tx.QueryContext(ctx, `
SELECT inference_id,ordinal,premise_assertion_id
FROM knowledge_inference_proofs
WHERE project_id=? AND generation_id=? ORDER BY inference_id,ordinal`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var inferenceID string
		var proof storedRelationProof
		if err := rows.Scan(&inferenceID, &proof.ordinal, &proof.premiseID); err != nil {
			rows.Close()
			return err
		}
		proofs[inferenceID] = append(proofs[inferenceID], proof)
	}
	if err := rows.Close(); err != nil {
		return err
	}

	axioms := map[string]storedRelationAxiom{}
	rows, err = tx.QueryContext(ctx, `
WITH active(ontology_id) AS (
 SELECT ontology_id FROM knowledge_generations WHERE project_id=? AND id=?
)
SELECT a.ontology_id,a.id,a.axiom_type,a.subject_key,a.object_key FROM ontology_axioms a
WHERE a.axiom_type IN('subproperty_of','inverse_of','symmetric','transitive')
AND (
 a.ontology_id=(SELECT ontology_id FROM active)
 OR (
   a.ontology_id IN(
     SELECT oi.imported_ontology_id FROM ontology_imports oi
     WHERE oi.ontology_id=(SELECT ontology_id FROM active)
   )
   AND NOT EXISTS(
     SELECT 1 FROM ontology_terms own
     WHERE own.ontology_id=(SELECT ontology_id FROM active) AND own.term_key=a.subject_key
   )
 )
)`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var ontologyID, axiomID string
		var axiom storedRelationAxiom
		if err := rows.Scan(&ontologyID, &axiomID, &axiom.kind, &axiom.subject, &axiom.object); err != nil {
			rows.Close()
			return err
		}
		axioms[ontologyID+"\x00"+axiomID] = axiom
	}
	if err := rows.Close(); err != nil {
		return err
	}

	assertions := map[string]storedRelationAssertion{}
	rows, err = tx.QueryContext(ctx, `
SELECT id,subject_entity_id,predicate_key,COALESCE(object_entity_id,''),literal_json,
       qualifiers_json,polarity,status,COALESCE(valid_from,''),COALESCE(valid_to,''),confidence
FROM knowledge_assertions WHERE project_id=? AND generation_id=?`, projectID, generationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var value storedRelationAssertion
		if err := rows.Scan(&value.id, &value.subject, &value.predicate, &value.object, &value.literal,
			&value.qualifiers, &value.polarity, &value.status, &value.validFrom, &value.validTo, &value.confidence); err != nil {
			rows.Close()
			return err
		}
		assertions[value.id] = value
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return validateStoredRelationInferences(inferences, byConclusion, proofs, axioms, assertions)
}

func validateStoredRelationInferences(
	inferences map[string]storedRelationInference,
	byConclusion map[string]string,
	proofs map[string][]storedRelationProof,
	axioms map[string]storedRelationAxiom,
	assertions map[string]storedRelationAssertion,
) error {
	for id, assertion := range assertions {
		if _, _, err := core.CanonicalKnowledgeInterval(assertion.validFrom, assertion.validTo); err != nil {
			return fmt.Errorf("knowledge assertion %s validity: %w", id, err)
		}
	}
	state := map[string]int{}
	var validate func(string) error
	validate = func(id string) error {
		if state[id] == 1 {
			return fmt.Errorf("knowledge relation inference proof cycle at %s", id)
		}
		if state[id] == 2 {
			return nil
		}
		inference, ok := inferences[id]
		if !ok || inference.status != "accepted" {
			return fmt.Errorf("knowledge relation inference %s is missing or not accepted", id)
		}
		conclusion, ok := assertions[inference.conclusionID]
		if !ok || conclusion.status != "accepted" || conclusion.polarity != "affirmed" {
			return fmt.Errorf("knowledge relation inference %s conclusion is missing or not accepted", id)
		}
		axiom, ok := axioms[inference.ontologyID+"\x00"+inference.axiomID]
		if !ok {
			return fmt.Errorf("knowledge relation inference %s references an unavailable rule", id)
		}
		items := proofs[id]
		wantProofs := 1
		if axiom.kind == "transitive" {
			wantProofs = 2
		}
		if len(items) != wantProofs {
			return fmt.Errorf("knowledge relation inference %s has %d proofs, want %d", id, len(items), wantProofs)
		}
		premises := make([]storedRelationAssertion, len(items))
		state[id] = 1
		for index, proof := range items {
			if proof.ordinal != index {
				return fmt.Errorf("knowledge relation inference %s proof ordinals are not contiguous", id)
			}
			premise, ok := assertions[proof.premiseID]
			if !ok || premise.status != "accepted" || premise.polarity != "affirmed" {
				return fmt.Errorf("knowledge relation inference %s has an invalid premise", id)
			}
			if parentID, inferred := byConclusion[premise.id]; inferred {
				if err := validate(parentID); err != nil {
					return err
				}
			}
			premises[index] = premise
		}
		if err := validateRelationConclusion(axiom, conclusion, premises); err != nil {
			return fmt.Errorf("knowledge relation inference %s: %w", id, err)
		}
		state[id] = 2
		return nil
	}
	for id := range inferences {
		if err := validate(id); err != nil {
			return err
		}
	}
	return nil
}

func validateRelationConclusion(axiom storedRelationAxiom, conclusion storedRelationAssertion, premises []storedRelationAssertion) error {
	sameValue := func(left, right storedRelationAssertion) (bool, error) {
		if left.subject != right.subject || left.object != right.object || left.literal != right.literal ||
			left.qualifiers != right.qualifiers || left.confidence != right.confidence {
			return false, nil
		}
		return relationIntervalsEqual(left.validFrom, left.validTo, right.validFrom, right.validTo)
	}
	switch axiom.kind {
	case "subproperty_of":
		premise := premises[0]
		expected := premise
		expected.predicate = axiom.object
		matches, err := sameValue(conclusion, expected)
		if err != nil {
			return err
		}
		if premise.predicate != axiom.subject || conclusion.predicate != expected.predicate || !matches {
			return errors.New("subPropertyOf conclusion does not preserve its premise value and conditions")
		}
	case "inverse_of":
		premise := premises[0]
		var expectedPredicate string
		switch premise.predicate {
		case axiom.subject:
			expectedPredicate = axiom.object
		case axiom.object:
			expectedPredicate = axiom.subject
		default:
			return errors.New("inverseOf premise predicate does not match its axiom")
		}
		intervalsMatch, err := relationIntervalsEqual(conclusion.validFrom, conclusion.validTo, premise.validFrom, premise.validTo)
		if err != nil {
			return err
		}
		if premise.object == "" || conclusion.literal != "" || conclusion.predicate != expectedPredicate ||
			conclusion.subject != premise.object || conclusion.object != premise.subject ||
			conclusion.qualifiers != premise.qualifiers || !intervalsMatch || conclusion.confidence != premise.confidence {
			return errors.New("inverseOf conclusion does not reverse its entity premise")
		}
	case "symmetric":
		premise := premises[0]
		intervalsMatch, err := relationIntervalsEqual(conclusion.validFrom, conclusion.validTo, premise.validFrom, premise.validTo)
		if err != nil {
			return err
		}
		if premise.predicate != axiom.subject || premise.object == "" || conclusion.literal != "" ||
			conclusion.predicate != premise.predicate || conclusion.subject != premise.object || conclusion.object != premise.subject ||
			conclusion.qualifiers != premise.qualifiers || !intervalsMatch || conclusion.confidence != premise.confidence {
			return errors.New("symmetric conclusion does not reverse its entity premise")
		}
	case "transitive":
		forward, forwardErr := validTransitiveConclusion(axiom, conclusion, premises[0], premises[1])
		reverse, reverseErr := validTransitiveConclusion(axiom, conclusion, premises[1], premises[0])
		if forwardErr != nil {
			return forwardErr
		}
		if reverseErr != nil {
			return reverseErr
		}
		if !forward && !reverse {
			return errors.New("transitive conclusion does not compose its two premises")
		}
	default:
		return fmt.Errorf("unsupported relation axiom %s", axiom.kind)
	}
	return nil
}

func validTransitiveConclusion(axiom storedRelationAxiom, conclusion, left, right storedRelationAssertion) (bool, error) {
	if left.predicate != axiom.subject || right.predicate != axiom.subject || conclusion.predicate != axiom.subject ||
		left.object == "" || right.object == "" || left.object != right.subject ||
		conclusion.subject != left.subject || conclusion.object != right.object || conclusion.literal != "" ||
		left.qualifiers != right.qualifiers || conclusion.qualifiers != left.qualifiers ||
		conclusion.confidence != math.Min(left.confidence, right.confidence) {
		return false, nil
	}
	from, to, ok, err := relationIntervalIntersection(left.validFrom, left.validTo, right.validFrom, right.validTo)
	if err != nil || !ok {
		return false, err
	}
	match, err := relationIntervalsEqual(conclusion.validFrom, conclusion.validTo, from, to)
	return match, err
}

func relationIntervalIntersection(leftFrom, leftTo, rightFrom, rightTo string) (string, string, bool, error) {
	leftStart, err := core.ParseKnowledgeTimeBoundary(leftFrom)
	if err != nil {
		return "", "", false, fmt.Errorf("invalid left validity start: %w", err)
	}
	leftEnd, err := core.ParseKnowledgeTimeBoundary(leftTo)
	if err != nil {
		return "", "", false, fmt.Errorf("invalid left validity end: %w", err)
	}
	rightStart, err := core.ParseKnowledgeTimeBoundary(rightFrom)
	if err != nil {
		return "", "", false, fmt.Errorf("invalid right validity start: %w", err)
	}
	rightEnd, err := core.ParseKnowledgeTimeBoundary(rightTo)
	if err != nil {
		return "", "", false, fmt.Errorf("invalid right validity end: %w", err)
	}
	if leftStart != nil && leftEnd != nil && leftStart.After(*leftEnd) {
		return "", "", false, errors.New("left validity interval starts after it ends")
	}
	if rightStart != nil && rightEnd != nil && rightStart.After(*rightEnd) {
		return "", "", false, errors.New("right validity interval starts after it ends")
	}
	from := laterKnowledgeTime(leftStart, rightStart)
	to := earlierKnowledgeTime(leftEnd, rightEnd)
	if from != nil && to != nil && from.After(*to) {
		return "", "", false, nil
	}
	canonicalFrom, canonicalTo := "", ""
	if from != nil {
		canonicalFrom = core.CanonicalKnowledgeTime(*from)
	}
	if to != nil {
		canonicalTo = core.CanonicalKnowledgeTime(*to)
	}
	return canonicalFrom, canonicalTo, true, nil
}

func relationIntervalsEqual(leftFrom, leftTo, rightFrom, rightTo string) (bool, error) {
	equalBoundary := func(left, right string) (bool, error) {
		leftTime, err := core.ParseKnowledgeTimeBoundary(left)
		if err != nil {
			return false, fmt.Errorf("invalid validity boundary %q: %w", left, err)
		}
		rightTime, err := core.ParseKnowledgeTimeBoundary(right)
		if err != nil {
			return false, fmt.Errorf("invalid validity boundary %q: %w", right, err)
		}
		if leftTime == nil || rightTime == nil {
			return leftTime == nil && rightTime == nil, nil
		}
		return leftTime.Equal(*rightTime), nil
	}
	fromEqual, err := equalBoundary(leftFrom, rightFrom)
	if err != nil || !fromEqual {
		return false, err
	}
	return equalBoundary(leftTo, rightTo)
}

func laterKnowledgeTime(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil || left.After(*right) {
		return left
	}
	return right
}

func earlierKnowledgeTime(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil || left.Before(*right) {
		return left
	}
	return right
}

package knowledge

import (
	"context"
	"fmt"
)

// validateCurationCandidate checks the semantic invariants that can be
// evaluated before an RDF snapshot receipt exists. The final Rebuild still
// executes the store's full immutable-generation validation and snapshot
// binding checks.
func (service *Service) validateCurationCandidate(ctx context.Context, projectID, generationID, ontologyID string) error {
	checks := []struct {
		query   string
		message string
		args    []any
	}{
		{`WITH reachable(ontology_id) AS (
  SELECT ?
  UNION
  SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = ?
)
SELECT COUNT(*) FROM knowledge_entities e
WHERE e.project_id = ? AND e.generation_id = ? AND NOT EXISTS (
  SELECT 1 FROM ontology_terms t
  WHERE t.term_key = e.class_key AND t.kind = 'class' AND (
    t.ontology_id = ? OR (
      t.ontology_id IN (SELECT ontology_id FROM reachable WHERE ontology_id <> ?)
      AND NOT EXISTS (
        SELECT 1 FROM ontology_terms own
        WHERE own.ontology_id = ? AND own.term_key = e.class_key
      )
    )
  )
)`, "knowledge entity references an unknown ontology class",
			[]any{ontologyID, ontologyID, projectID, generationID, ontologyID, ontologyID, ontologyID}},
		{`SELECT COUNT(*) FROM knowledge_entities e
LEFT JOIN knowledge_mentions m ON m.project_id=e.project_id AND m.generation_id=e.generation_id AND m.entity_id=e.id
WHERE e.project_id=? AND e.generation_id=? AND m.id IS NULL
  AND NOT EXISTS(
    SELECT 1 FROM knowledge_assertions a
    JOIN knowledge_assertion_evidence ae
      ON ae.project_id=a.project_id AND ae.generation_id=a.generation_id AND ae.assertion_id=a.id
    WHERE a.project_id=e.project_id AND a.generation_id=e.generation_id
      AND ae.evidence_kind='artifact_value'
      AND (a.subject_entity_id=e.id OR a.object_entity_id=e.id OR EXISTS(
        SELECT 1 FROM json_each(a.qualifiers_json) q
        WHERE json_extract(q.value,'$.entity_id')=e.id
      ))
  )`, "knowledge entity has neither source mention nor artifact-backed assertion provenance",
			[]any{projectID, generationID}},
		{`WITH reachable(ontology_id) AS (
  SELECT ?
  UNION
  SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id = ?
)
SELECT COUNT(*) FROM knowledge_assertions a
WHERE a.project_id=? AND a.generation_id=? AND NOT EXISTS(
  SELECT 1 FROM ontology_terms t
  WHERE t.term_key=a.predicate_key
    AND ((a.object_entity_id IS NOT NULL AND t.kind='object_property' AND t.value_kind='entity')
      OR (a.object_entity_id IS NULL AND t.kind='datatype_property' AND t.value_kind<>'entity'))
    AND (t.ontology_id=? OR (
      t.ontology_id IN (SELECT ontology_id FROM reachable WHERE ontology_id<>?)
      AND NOT EXISTS(
        SELECT 1 FROM ontology_terms own
        WHERE own.ontology_id=? AND own.term_key=a.predicate_key
      )
    )
  )
)`, "knowledge assertion references an incompatible ontology predicate",
			[]any{ontologyID, ontologyID, projectID, generationID, ontologyID, ontologyID, ontologyID}},
		{`SELECT COUNT(*) FROM knowledge_assertions a
LEFT JOIN knowledge_assertion_evidence e
 ON e.project_id=a.project_id AND e.generation_id=a.generation_id AND e.assertion_id=a.id
WHERE a.project_id=? AND a.generation_id=? AND e.assertion_id IS NULL`,
			"knowledge assertion has no evidence", []any{projectID, generationID}},
		{`SELECT COUNT(*) FROM (
 SELECT assertion_key FROM knowledge_assertions
 WHERE project_id=? AND generation_id=?
 GROUP BY assertion_key HAVING COUNT(*)>1
)`, "knowledge generation contains duplicate semantic assertions", []any{projectID, generationID}},
		{`SELECT COUNT(*) FROM knowledge_inferences i
LEFT JOIN knowledge_inference_proofs p
 ON p.project_id=i.project_id AND p.generation_id=i.generation_id AND p.inference_id=i.id
WHERE i.project_id=? AND i.generation_id=? AND p.inference_id IS NULL`,
			"knowledge inference has no proof", []any{projectID, generationID}},
		{`SELECT COUNT(*) FROM knowledge_type_inferences i
LEFT JOIN knowledge_type_inference_proofs p
 ON p.project_id=i.project_id AND p.generation_id=i.generation_id AND p.inference_id=i.id
WHERE i.project_id=? AND i.generation_id=? AND p.inference_id IS NULL`,
			"knowledge type inference has no proof", []any{projectID, generationID}},
	}
	for _, check := range checks {
		var invalid int
		if err := service.DB.SQL().QueryRowContext(ctx, check.query, check.args...).Scan(&invalid); err != nil {
			return err
		}
		if invalid != 0 {
			return fmt.Errorf("%s (%d rows)", check.message, invalid)
		}
	}
	return nil
}

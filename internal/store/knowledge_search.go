package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/rag"
)

const (
	graphBaselineLimit     = 20
	graphSeedLimit         = 8
	graphAssertionLimit    = 32
	graphEvidenceLimit     = 24
	graphOnlyLimit         = 4
	perSourceArtifactLimit = 2
)

// ErrKnowledgeGraphUnavailable is returned whenever hybrid_graph_v1 cannot
// use the exact requested ready generation. Callers must surface the block;
// they must never retry through hybrid_v1 or lexical-only retrieval.
var ErrKnowledgeGraphUnavailable = errors.New("hybrid_graph_v1 knowledge graph unavailable")

type GraphMemoryResult struct {
	MemoryResult
	GraphDerived bool     `json:"graph_derived"`
	AssertionIDs []string `json:"assertion_ids,omitempty"`
}

// SearchMemoryWithGraph is the fail-closed hybrid_graph_v1 retrieval profile.
// A missing, stale, failed, or corrupt graph is an error and never degrades to
// hybrid_v1. Exact vector search remains multicore through rag.ExactTopK.
func (db *DB) SearchMemoryWithGraph(ctx context.Context, projectID, query string, queryVector []float32, limit int) ([]GraphMemoryResult, error) {
	generationID, ontologyID, err := db.activeReadyKnowledgeGeneration(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return db.searchMemoryWithGraphGeneration(ctx, projectID, generationID, ontologyID, query, queryVector, limit)
}

// SearchMemoryWithGraphGeneration performs retrieval against the immutable
// generation pinned to a run. A later active-head swap must never change the
// evidence seen by an already-started run.
func (db *DB) SearchMemoryWithGraphGeneration(ctx context.Context, projectID, generationID, query string, queryVector []float32, limit int) ([]GraphMemoryResult, error) {
	generation, err := db.KnowledgeGeneration(ctx, projectID, generationID)
	if err != nil {
		return nil, err
	}
	if generation.State != KnowledgeReady && generation.State != KnowledgeRetired {
		return nil, fmt.Errorf("%w: run-pinned knowledge generation is %s", ErrKnowledgeGraphUnavailable, generation.State)
	}
	return db.searchMemoryWithGraphGeneration(ctx, projectID, generationID, generation.OntologyID, query, queryVector, limit)
}

func (db *DB) searchMemoryWithGraphGeneration(ctx context.Context, projectID, generationID, ontologyID, query string, queryVector []float32, limit int) ([]GraphMemoryResult, error) {
	if limit <= 0 || limit > memoryResultLimit {
		limit = memoryResultLimit
	}
	lexical, err := db.lexicalCandidates(ctx, projectID, query)
	if err != nil {
		return nil, fmt.Errorf("lexical retrieval failed: %w", err)
	}
	semantic, err := db.semanticCandidates(ctx, projectID, queryVector)
	if err != nil {
		return nil, fmt.Errorf("vector retrieval failed: %w", err)
	}
	baseline := rag.ReciprocalRankFusion(lexical, semantic, graphBaselineLimit)
	seedIDs, err := db.seedKnowledgeEntities(ctx, projectID, generationID, baseline)
	if err != nil {
		return nil, err
	}
	assertionIDs, err := db.expandKnowledgeAssertions(ctx, projectID, generationID, ontologyID, seedIDs)
	if err != nil {
		return nil, err
	}
	graphChunks, chunkAssertions, err := db.graphEvidenceChunks(ctx, projectID, generationID, assertionIDs)
	if err != nil {
		return nil, err
	}
	// Keep the complete bounded candidate union. Truncating to 50 here makes a
	// graph-only item mathematically unreachable at weight 0.5 whenever both
	// baseline retrievers return 50 items, and it prevents source-diversity
	// top-up from considering the remaining bounded candidates.
	fused := rag.WeightedReciprocalRankFusion([]rag.WeightedRanking{{Weight: 1, Items: lexical}, {Weight: 1, Items: semantic}, {Weight: .5, Items: graphChunks}}, 0)
	loaded, err := db.loadGraphMemoryResults(ctx, projectID, fused)
	if err != nil {
		return nil, err
	}
	baselineIDs := make(map[string]bool, len(lexical)+len(semantic))
	for _, item := range lexical {
		baselineIDs[item.ID] = true
	}
	for _, item := range semantic {
		baselineIDs[item.ID] = true
	}
	graphIDs := make(map[string]bool, len(graphChunks))
	for _, item := range graphChunks {
		graphIDs[item.ID] = true
	}
	return selectGraphMemoryResults(loaded, baselineIDs, graphIDs, chunkAssertions, limit), nil
}

// loadGraphMemoryResults reads the complete bounded RRF union in one query.
// The union contains at most 50 lexical + 50 vector + 24 graph candidates, so
// it remains comfortably below SQLite's parameter limit while avoiding one
// metadata query per candidate.
func (db *DB) loadGraphMemoryResults(ctx context.Context, projectID string, ranked []rag.Ranked) ([]MemoryResult, error) {
	if len(ranked) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(ranked)), ",")
	arguments := make([]any, 0, len(ranked)+1)
	arguments = append(arguments, projectID)
	for _, item := range ranked {
		arguments = append(arguments, item.ID)
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT c.id,c.document_id,COALESCE(d.artifact_id,''),d.title,c.text
FROM chunks c
JOIN documents d ON d.id=c.document_id
WHERE d.project_id=? AND d.status='ready' AND c.id IN (`+placeholders+`)`, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]MemoryResult, len(ranked))
	for rows.Next() {
		var item MemoryResult
		if err := rows.Scan(&item.ChunkID, &item.DocumentID, &item.ArtifactID, &item.Title, &item.Text); err != nil {
			return nil, err
		}
		byID[item.ChunkID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	loaded := make([]MemoryResult, 0, len(ranked))
	for _, candidate := range ranked {
		item, ok := byID[candidate.ID]
		if !ok {
			return nil, fmt.Errorf("hybrid graph candidate %s is not readable project memory", candidate.ID)
		}
		item.Score = candidate.Score
		loaded = append(loaded, item)
	}
	return loaded, nil
}

// selectGraphMemoryResults reserves up to four graph-only results and then
// fills the remaining slots from the complete weighted-RRF order. Both passes
// share the source counter, so reservation never weakens the two-per-artifact
// contract. The final sort restores weighted-RRF score order for presentation.
func selectGraphMemoryResults(loaded []MemoryResult, baselineIDs, graphIDs map[string]bool, chunkAssertions map[string][]string, limit int) []GraphMemoryResult {
	if limit <= 0 {
		return nil
	}
	perSourceArtifact := map[string]int{}
	selected := map[string]bool{}
	results := make([]GraphMemoryResult, 0, min(limit, len(loaded)))
	appendItem := func(item MemoryResult) bool {
		if selected[item.ChunkID] || len(results) >= limit {
			return false
		}
		sourceArtifact := memorySourceArtifact(item)
		if perSourceArtifact[sourceArtifact] >= perSourceArtifactLimit {
			return false
		}
		selected[item.ChunkID] = true
		perSourceArtifact[sourceArtifact]++
		results = append(results, GraphMemoryResult{
			MemoryResult: item, GraphDerived: graphIDs[item.ChunkID],
			AssertionIDs: append([]string(nil), chunkAssertions[item.ChunkID]...),
		})
		return true
	}

	graphOnly := 0
	graphReserve := min(graphOnlyLimit, limit)
	for _, item := range loaded {
		if graphOnly == graphReserve {
			break
		}
		if graphIDs[item.ChunkID] && !baselineIDs[item.ChunkID] && appendItem(item) {
			graphOnly++
		}
	}
	for _, item := range loaded {
		if len(results) == limit {
			break
		}
		if graphIDs[item.ChunkID] && !baselineIDs[item.ChunkID] {
			continue
		}
		appendItem(item)
	}
	sort.Slice(results, func(left, right int) bool {
		if results[left].Score == results[right].Score {
			return results[left].ChunkID < results[right].ChunkID
		}
		return results[left].Score > results[right].Score
	})
	return results
}

func memorySourceArtifact(item MemoryResult) string {
	if item.ArtifactID != "" {
		return "artifact:" + item.ArtifactID
	}
	return "document:" + item.DocumentID
}

func (db *DB) activeReadyKnowledgeGeneration(ctx context.Context, projectID string) (string, string, error) {
	var generationID, ontologyID, headStatus, generationState string
	err := db.sql.QueryRowContext(ctx, `
SELECT h.generation_id, g.ontology_id, h.status, g.state
FROM project_knowledge_heads h
JOIN knowledge_generations g ON g.project_id=h.project_id AND g.id=h.generation_id
WHERE h.project_id=?`, projectID).Scan(&generationID, &ontologyID, &headStatus, &generationState)
	if err != nil {
		return "", "", err
	}
	if headStatus != "ready" || generationState != "ready" {
		return "", "", fmt.Errorf("%w: knowledge graph is %s/%s", ErrKnowledgeGraphUnavailable, headStatus, generationState)
	}
	return generationID, ontologyID, nil
}

func (db *DB) seedKnowledgeEntities(ctx context.Context, projectID, generationID string, baseline []rag.Ranked) ([]string, error) {
	seen := map[string]bool{}
	seeds := make([]string, 0, graphSeedLimit)
	for _, chunk := range baseline {
		rows, err := db.sql.QueryContext(ctx, `
SELECT entity_id FROM knowledge_mentions
WHERE project_id=? AND generation_id=? AND chunk_id=?
ORDER BY entity_id LIMIT ?`, projectID, generationID, chunk.ID, graphSeedLimit)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var entityID string
			if err := rows.Scan(&entityID); err != nil {
				rows.Close()
				return nil, err
			}
			if !seen[entityID] {
				seen[entityID] = true
				seeds = append(seeds, entityID)
				if len(seeds) == graphSeedLimit {
					break
				}
			}
		}
		closeErr := rows.Close()
		if closeErr != nil {
			return nil, closeErr
		}
		if len(seeds) == graphSeedLimit {
			break
		}
	}
	return seeds, nil
}

func (db *DB) expandKnowledgeAssertions(ctx context.Context, projectID, generationID, ontologyID string, seeds []string) ([]string, error) {
	if len(seeds) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(seeds)), ",")
	query := `
SELECT DISTINCT a.id
FROM knowledge_assertions a
WHERE a.project_id=? AND a.generation_id=?
  AND a.status IN ('accepted','disputed')
  AND EXISTS(
    SELECT 1 FROM ontology_terms t
    WHERE t.term_key=a.predicate_key AND t.expandable=1 AND (
      t.ontology_id=? OR (
        t.ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
        AND NOT EXISTS(SELECT 1 FROM ontology_terms local
                       WHERE local.ontology_id=? AND local.term_key=a.predicate_key)
      )
    )
  )
  AND (a.subject_entity_id IN (` + placeholders + `) OR a.object_entity_id IN (` + placeholders + `))
ORDER BY CASE a.status WHEN 'disputed' THEN 0 ELSE 1 END, a.id
LIMIT ?`
	arguments := make([]any, 0, 6+len(seeds)*2)
	arguments = append(arguments, projectID, generationID, ontologyID, ontologyID, ontologyID)
	for _, seed := range seeds {
		arguments = append(arguments, seed)
	}
	for _, seed := range seeds {
		arguments = append(arguments, seed)
	}
	arguments = append(arguments, graphAssertionLimit)
	rows, err := db.sql.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return db.includeDisputedCounterparts(ctx, projectID, generationID, ids)
}

func (db *DB) includeDisputedCounterparts(ctx context.Context, projectID, generationID string, ids []string) ([]string, error) {
	counterparts := make(map[string][]string, len(ids))
	for _, id := range ids {
		rows, err := db.sql.QueryContext(ctx, `
SELECT left_assertion_id,right_assertion_id FROM knowledge_conflicts
WHERE project_id=? AND generation_id=? AND status='open'
  AND (left_assertion_id=? OR right_assertion_id=?) ORDER BY id`, projectID, generationID, id, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var left, right string
			if err := rows.Scan(&left, &right); err != nil {
				rows.Close()
				return nil, err
			}
			other := left
			if other == id {
				other = right
			}
			counterparts[id] = appendUniqueString(counterparts[id], other)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return selectAssertionCounterpartGroups(ids, counterparts, graphAssertionLimit), nil
}

// selectAssertionCounterpartGroups keeps every included open dispute pair
// together while enforcing the global 32-assertion expansion limit. A group
// that cannot fit is omitted as a whole; returning one side without its
// counterpart would make the retrieved evidence misleading.
func selectAssertionCounterpartGroups(ids []string, counterparts map[string][]string, limit int) []string {
	if limit <= 0 {
		return nil
	}
	seen := map[string]bool{}
	excluded := map[string]bool{}
	result := make([]string, 0, min(limit, len(ids)))
	for _, id := range ids {
		if seen[id] || excluded[id] {
			continue
		}
		group := []string{id}
		for _, other := range counterparts[id] {
			if other != "" && !seen[other] && !excluded[other] {
				group = appendUniqueString(group, other)
			}
		}
		sort.Strings(group[1:])
		if len(result)+len(group) > limit {
			for _, member := range group {
				excluded[member] = true
			}
			continue
		}
		for _, member := range group {
			seen[member] = true
			result = append(result, member)
		}
	}
	return result
}

func (db *DB) graphEvidenceChunks(ctx context.Context, projectID, generationID string, assertionIDs []string) ([]rag.Ranked, map[string][]string, error) {
	if len(assertionIDs) == 0 {
		return nil, map[string][]string{}, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(assertionIDs)), ",")
	arguments := make([]any, 0, 2+len(assertionIDs)+1)
	arguments = append(arguments, projectID, generationID)
	for _, id := range assertionIDs {
		arguments = append(arguments, id)
	}
	arguments = append(arguments, graphEvidenceLimit)
	rows, err := db.sql.QueryContext(ctx, `
WITH ranked_evidence AS (
  SELECT ae.assertion_id,ae.chunk_id,
         ROW_NUMBER() OVER(PARTITION BY ae.assertion_id ORDER BY ae.chunk_id) AS ordinal
  FROM knowledge_assertion_evidence ae
  JOIN chunks c ON c.id=ae.chunk_id
  JOIN documents d ON d.id=c.document_id AND d.project_id=ae.project_id AND d.status='ready'
  WHERE ae.project_id=? AND ae.generation_id=? AND ae.assertion_id IN (`+placeholders+`)
)
SELECT assertion_id,chunk_id FROM ranked_evidence
WHERE ordinal<=? ORDER BY assertion_id,chunk_id`, arguments...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	evidenceByAssertion := make(map[string][]string, len(assertionIDs))
	for rows.Next() {
		var assertionID, chunkID string
		if err := rows.Scan(&assertionID, &chunkID); err != nil {
			return nil, nil, err
		}
		evidenceByAssertion[assertionID] = appendUniqueString(evidenceByAssertion[assertionID], chunkID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	counterparts, err := db.selectedAssertionCounterparts(ctx, projectID, generationID, assertionIDs)
	if err != nil {
		return nil, nil, err
	}
	ranked, chunkAssertions := selectGraphEvidenceBundles(assertionIDs, counterparts, evidenceByAssertion, graphEvidenceLimit)
	return ranked, chunkAssertions, nil
}

func (db *DB) selectedAssertionCounterparts(ctx context.Context, projectID, generationID string, assertionIDs []string) (map[string][]string, error) {
	result := make(map[string][]string, len(assertionIDs))
	if len(assertionIDs) == 0 {
		return result, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(assertionIDs)), ",")
	arguments := make([]any, 0, 2+len(assertionIDs)*2)
	arguments = append(arguments, projectID, generationID)
	for _, id := range assertionIDs {
		arguments = append(arguments, id)
	}
	for _, id := range assertionIDs {
		arguments = append(arguments, id)
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT left_assertion_id,right_assertion_id FROM knowledge_conflicts
WHERE project_id=? AND generation_id=? AND status='open'
  AND left_assertion_id IN (`+placeholders+`)
  AND right_assertion_id IN (`+placeholders+`)
ORDER BY id`, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var left, right string
		if err := rows.Scan(&left, &right); err != nil {
			return nil, err
		}
		result[left] = appendUniqueString(result[left], right)
		result[right] = appendUniqueString(result[right], left)
	}
	return result, rows.Err()
}

// selectGraphEvidenceBundles applies the 24-chunk limit to whole dispute
// groups. Every selected dispute contributes at least one evidence chunk for
// every member; a group that cannot fit those minimum handles is omitted.
// Additional handles are taken round-robin so one assertion cannot starve its
// counterpart.
func selectGraphEvidenceBundles(assertionIDs []string, counterparts map[string][]string, evidenceByAssertion map[string][]string, limit int) ([]rag.Ranked, map[string][]string) {
	chunkAssertions := map[string][]string{}
	if limit <= 0 {
		return nil, chunkAssertions
	}
	groups := assertionCounterpartGroups(assertionIDs, counterparts)
	ranked := make([]rag.Ranked, 0, limit)
	seenChunks := map[string]bool{}
	appendChunk := func(chunkID, assertionID string) bool {
		if seenChunks[chunkID] {
			chunkAssertions[chunkID] = appendUniqueString(chunkAssertions[chunkID], assertionID)
			return true
		}
		if len(ranked) == limit {
			return false
		}
		seenChunks[chunkID] = true
		chunkAssertions[chunkID] = appendUniqueString(chunkAssertions[chunkID], assertionID)
		ranked = append(ranked, rag.Ranked{ID: chunkID})
		return true
	}
	for _, group := range groups {
		if len(ranked) == limit {
			break
		}
		if len(group) == 1 {
			for _, chunkID := range evidenceByAssertion[group[0]] {
				if !appendChunk(chunkID, group[0]) {
					break
				}
			}
			continue
		}

		minimumOrder := []string{}
		minimumAssertions := map[string][]string{}
		minimumSeen := map[string]bool{}
		complete := true
		for _, assertionID := range group {
			chunks := evidenceByAssertion[assertionID]
			if len(chunks) == 0 {
				complete = false
				break
			}
			chunkID := chunks[0]
			minimumAssertions[chunkID] = appendUniqueString(minimumAssertions[chunkID], assertionID)
			if !minimumSeen[chunkID] {
				minimumSeen[chunkID] = true
				minimumOrder = append(minimumOrder, chunkID)
			}
		}
		if !complete || len(minimumOrder) > limit-len(ranked) {
			continue
		}
		for _, chunkID := range minimumOrder {
			for _, assertionID := range minimumAssertions[chunkID] {
				appendChunk(chunkID, assertionID)
			}
		}
		for ordinal := 1; len(ranked) < limit; ordinal++ {
			advanced := false
			for _, assertionID := range group {
				chunks := evidenceByAssertion[assertionID]
				if ordinal >= len(chunks) {
					continue
				}
				advanced = true
				if !appendChunk(chunks[ordinal], assertionID) && len(ranked) == limit {
					break
				}
			}
			if !advanced {
				break
			}
		}
	}
	return ranked, chunkAssertions
}

func assertionCounterpartGroups(assertionIDs []string, counterparts map[string][]string) [][]string {
	allowed := make(map[string]bool, len(assertionIDs))
	for _, id := range assertionIDs {
		allowed[id] = true
	}
	seen := map[string]bool{}
	groups := make([][]string, 0, len(assertionIDs))
	for _, id := range assertionIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		group := []string{id}
		for cursor := 0; cursor < len(group); cursor++ {
			for _, other := range counterparts[group[cursor]] {
				if allowed[other] && !seen[other] {
					seen[other] = true
					group = append(group, other)
				}
			}
		}
		groups = append(groups, group)
	}
	return groups
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

// KnowledgeGenerationForRun pins a run to the graph revision observed at
// start, preventing a mid-run active-head swap from changing its evidence.
func (db *DB) KnowledgeGenerationForRun(ctx context.Context, runID string) (string, error) {
	var generationID string
	err := db.sql.QueryRowContext(ctx, "SELECT knowledge_generation_id FROM runs WHERE id=?", runID).Scan(&generationID)
	if err != nil {
		return "", err
	}
	if generationID == "" {
		return "", errors.New("run is not pinned to a knowledge generation")
	}
	return generationID, nil
}

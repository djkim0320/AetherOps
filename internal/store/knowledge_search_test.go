package store

import (
	"fmt"
	"testing"
)

func TestSelectAssertionCounterpartGroupsEnforcesLimitWithoutSplittingDisputes(t *testing.T) {
	base := make([]string, 0, 32)
	counterparts := map[string][]string{}
	for index := 0; index < 32; index++ {
		id := fmt.Sprintf("assertion-%02d", index)
		other := fmt.Sprintf("counterpart-%02d", index)
		base = append(base, id)
		counterparts[id] = []string{other}
	}
	selected := selectAssertionCounterpartGroups(base, counterparts, graphAssertionLimit)
	if len(selected) != graphAssertionLimit {
		t.Fatalf("selected assertion count = %d, want %d", len(selected), graphAssertionLimit)
	}
	present := map[string]bool{}
	for _, id := range selected {
		present[id] = true
	}
	for index := 0; index < 32; index++ {
		id := fmt.Sprintf("assertion-%02d", index)
		other := fmt.Sprintf("counterpart-%02d", index)
		if present[id] != present[other] {
			t.Fatalf("dispute pair was split: %s=%v %s=%v", id, present[id], other, present[other])
		}
	}
}

func TestSelectAssertionCounterpartGroupsDropsOversizedDisputeAsAWhole(t *testing.T) {
	others := make([]string, 0, graphAssertionLimit)
	for index := 0; index < graphAssertionLimit; index++ {
		others = append(others, fmt.Sprintf("other-%02d", index))
	}
	selected := selectAssertionCounterpartGroups(
		[]string{"oversized", "independent"},
		map[string][]string{"oversized": others},
		graphAssertionLimit,
	)
	if len(selected) != 1 || selected[0] != "independent" {
		t.Fatalf("oversized dispute selection = %v", selected)
	}
}

func TestSelectGraphMemoryResultsReservesGraphOnlyAndTopsUpPastSourceCap(t *testing.T) {
	loaded := make([]MemoryResult, 0, 68)
	baselineIDs := map[string]bool{}
	graphIDs := map[string]bool{}
	chunkAssertions := map[string][]string{}
	for index := 0; index < 60; index++ {
		id := fmt.Sprintf("baseline-%02d", index)
		artifactID := "artifact-hot"
		if index >= 50 {
			artifactID = fmt.Sprintf("artifact-baseline-%02d", (index-50)/2)
		}
		loaded = append(loaded, MemoryResult{ChunkID: id, DocumentID: "doc-" + id, ArtifactID: artifactID, Score: 200 - float64(index)})
		baselineIDs[id] = true
	}
	for index := 0; index < 8; index++ {
		id := fmt.Sprintf("graph-%02d", index)
		loaded = append(loaded, MemoryResult{ChunkID: id, DocumentID: "doc-" + id, ArtifactID: fmt.Sprintf("artifact-graph-%02d", index/2), Score: 10 - float64(index)})
		graphIDs[id] = true
		chunkAssertions[id] = []string{"assertion-" + id}
	}

	results := selectGraphMemoryResults(loaded, baselineIDs, graphIDs, chunkAssertions, memoryResultLimit)
	if len(results) != memoryResultLimit {
		t.Fatalf("result count = %d, want %d", len(results), memoryResultLimit)
	}
	graphOnly := 0
	perArtifact := map[string]int{}
	toppedUp := false
	for _, result := range results {
		perArtifact[result.ArtifactID]++
		if perArtifact[result.ArtifactID] > perSourceArtifactLimit {
			t.Fatalf("artifact %s exceeded source cap: %+v", result.ArtifactID, results)
		}
		if graphIDs[result.ChunkID] && !baselineIDs[result.ChunkID] {
			graphOnly++
			if !result.GraphDerived || len(result.AssertionIDs) != 1 {
				t.Fatalf("graph-only provenance was lost: %+v", result)
			}
		}
		if result.ChunkID == "baseline-50" {
			toppedUp = true
		}
	}
	if graphOnly != graphOnlyLimit {
		t.Fatalf("graph-only result count = %d, want %d", graphOnly, graphOnlyLimit)
	}
	if !toppedUp {
		t.Fatal("source-cap filtering did not continue beyond the former top-50 cutoff")
	}
	for index := 1; index < len(results); index++ {
		if results[index-1].Score < results[index].Score {
			t.Fatalf("result score order was not restored: %+v", results)
		}
	}
}

func TestSelectGraphEvidenceBundlesBalancesDisputeEvidence(t *testing.T) {
	leftChunks := make([]string, 10)
	for index := range leftChunks {
		leftChunks[index] = fmt.Sprintf("left-chunk-%02d", index)
	}
	ranked, chunkAssertions := selectGraphEvidenceBundles(
		[]string{"left", "right", "independent"},
		map[string][]string{"left": {"right"}, "right": {"left"}},
		map[string][]string{
			"left": leftChunks, "right": {"right-chunk-00"}, "independent": {"independent-chunk"},
		},
		4,
	)
	if len(ranked) != 4 {
		t.Fatalf("evidence result count = %d, want 4: %+v", len(ranked), ranked)
	}
	present := map[string]bool{}
	for chunkID, assertions := range chunkAssertions {
		for _, assertionID := range assertions {
			present[assertionID] = true
		}
		if chunkID == "independent-chunk" {
			t.Fatal("independent evidence displaced the already selected balanced dispute bundle")
		}
	}
	if !present["left"] || !present["right"] {
		t.Fatalf("dispute evidence was split: %+v", chunkAssertions)
	}
}

func TestSelectGraphEvidenceBundlesOmitsPairAtLimitBoundary(t *testing.T) {
	ranked, chunkAssertions := selectGraphEvidenceBundles(
		[]string{"independent", "left", "right"},
		map[string][]string{"left": {"right"}, "right": {"left"}},
		map[string][]string{
			"independent": {"independent-0", "independent-1"},
			"left":        {"left-0"},
			"right":       {"right-0"},
		},
		3,
	)
	if len(ranked) != 2 {
		t.Fatalf("partial dispute consumed the final slot: %+v", ranked)
	}
	for _, assertions := range chunkAssertions {
		for _, assertionID := range assertions {
			if assertionID == "left" || assertionID == "right" {
				t.Fatalf("one side of an unfit dispute was returned: %+v", chunkAssertions)
			}
		}
	}
}

package core

import "testing"

func TestCanonicalKnowledgeIntervalUsesFixedWidthUTC(t *testing.T) {
	from, to, err := CanonicalKnowledgeInterval(
		"2026-08-09T12:34:56.1+09:00",
		"2026-08-09T03:34:56.100000000Z",
	)
	if err != nil {
		t.Fatal(err)
	}
	const want = "2026-08-09T03:34:56.100000000Z"
	if from != want || to != want {
		t.Fatalf("canonical interval = %q/%q, want %q/%q", from, to, want, want)
	}
}

func TestCanonicalKnowledgeIntervalOpenAndInvalidBoundaries(t *testing.T) {
	from, to, err := CanonicalKnowledgeInterval("", "2026-08-09T12:34:56Z")
	if err != nil {
		t.Fatal(err)
	}
	if from != "" || to != "2026-08-09T12:34:56.000000000Z" {
		t.Fatalf("open interval = %q/%q", from, to)
	}
	if _, _, err := CanonicalKnowledgeInterval("not-rfc3339", ""); err == nil {
		t.Fatal("invalid RFC3339 boundary was accepted")
	}
	if _, _, err := CanonicalKnowledgeInterval(
		"2026-08-09T12:00:00-10:00",
		"2026-08-09T13:00:00+10:00",
	); err == nil {
		t.Fatal("semantically reversed offset interval was accepted")
	}
}

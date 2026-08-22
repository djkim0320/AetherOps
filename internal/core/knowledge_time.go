package core

import (
	"errors"
	"time"
)

// KnowledgeTimeLayout is the sole persisted representation for knowledge
// assertion validity boundaries. Fixed-width UTC keeps deterministic hashes
// and SQLite ordering while ParseKnowledgeTimeBoundary continues to accept
// historical RFC3339Nano offsets and fractional precision.
const KnowledgeTimeLayout = "2006-01-02T15:04:05.000000000Z"

func CanonicalKnowledgeTime(value time.Time) string {
	return value.UTC().Format(KnowledgeTimeLayout)
}

// ParseKnowledgeTimeBoundary treats only the empty string as an open bound.
func ParseKnowledgeTimeBoundary(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func CanonicalKnowledgeTimeBoundary(value string) (string, error) {
	parsed, err := ParseKnowledgeTimeBoundary(value)
	if err != nil || parsed == nil {
		return "", err
	}
	return CanonicalKnowledgeTime(*parsed), nil
}

// CanonicalKnowledgeInterval accepts open or closed boundaries and preserves
// inclusive equality. Reversed intervals are rejected by semantic time value,
// never by their original textual representation.
func CanonicalKnowledgeInterval(from, to string) (string, string, error) {
	parsedFrom, err := ParseKnowledgeTimeBoundary(from)
	if err != nil {
		return "", "", err
	}
	parsedTo, err := ParseKnowledgeTimeBoundary(to)
	if err != nil {
		return "", "", err
	}
	if parsedFrom != nil && parsedTo != nil && parsedFrom.After(*parsedTo) {
		return "", "", errors.New("knowledge validity interval starts after it ends")
	}
	canonicalFrom, canonicalTo := "", ""
	if parsedFrom != nil {
		canonicalFrom = CanonicalKnowledgeTime(*parsedFrom)
	}
	if parsedTo != nil {
		canonicalTo = CanonicalKnowledgeTime(*parsedTo)
	}
	return canonicalFrom, canonicalTo, nil
}

package knowledge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
)

const defaultInferenceLimit = 10000

type Statement struct {
	ID         string               `json:"id"`
	Subject    string               `json:"subject"`
	Predicate  string               `json:"predicate"`
	Object     RDFObject            `json:"object"`
	Qualifiers map[string]RDFObject `json:"qualifiers,omitempty"`
	ValidFrom  *time.Time           `json:"valid_from,omitempty"`
	ValidTo    *time.Time           `json:"valid_to,omitempty"`
	Inferred   bool                 `json:"inferred"`
}

type Inference struct {
	Statement Statement `json:"statement"`
	RuleID    string    `json:"rule_id"`
	ParentIDs []string  `json:"parent_ids"`
}

type Conflict struct {
	LeftID    string `json:"left_id"`
	RightID   string `json:"right_id"`
	Predicate string `json:"predicate"`
	Reason    string `json:"reason"`
}

type OntologyRules struct {
	SubClass    map[string][]string
	SubProperty map[string][]string
	Domain      map[string][]string
	Range       map[string][]string
	Inverse     map[string][]string
	Symmetric   map[string]bool
	Transitive  map[string]bool
	Functional  map[string]bool
	Expandable  map[string]bool
}

func CompileOntologyRules(triples []RDFTriple) OntologyRules {
	rules := OntologyRules{SubClass: map[string][]string{}, SubProperty: map[string][]string{}, Domain: map[string][]string{}, Range: map[string][]string{}, Inverse: map[string][]string{}, Symmetric: map[string]bool{}, Transitive: map[string]bool{}, Functional: map[string]bool{}, Expandable: map[string]bool{}}
	for _, triple := range triples {
		switch triple.Predicate {
		case rdfsNS + "subClassOf":
			rules.SubClass[triple.Subject] = appendUnique(rules.SubClass[triple.Subject], triple.Object.IRI)
		case rdfsNS + "subPropertyOf":
			rules.SubProperty[triple.Subject] = appendUnique(rules.SubProperty[triple.Subject], triple.Object.IRI)
		case rdfsNS + "domain":
			rules.Domain[triple.Subject] = appendUnique(rules.Domain[triple.Subject], triple.Object.IRI)
		case rdfsNS + "range":
			rules.Range[triple.Subject] = appendUnique(rules.Range[triple.Subject], triple.Object.IRI)
		case owlNS + "inverseOf":
			rules.Inverse[triple.Subject] = appendUnique(rules.Inverse[triple.Subject], triple.Object.IRI)
			rules.Inverse[triple.Object.IRI] = appendUnique(rules.Inverse[triple.Object.IRI], triple.Subject)
		case rdfNS + "type":
			switch triple.Object.IRI {
			case owlNS + "SymmetricProperty":
				rules.Symmetric[triple.Subject] = true
				rules.Expandable[triple.Subject] = true
			case owlNS + "TransitiveProperty":
				rules.Transitive[triple.Subject] = true
				rules.Expandable[triple.Subject] = true
			case owlNS + "FunctionalProperty":
				rules.Functional[triple.Subject] = true
			case owlNS + "ObjectProperty":
				rules.Expandable[triple.Subject] = true
			}
		}
	}
	return rules
}

// Infer implements only AetherOps' documented RDFS/OWL subset. Every derived
// statement has an immediate proof edge; no result is emitted without parents.
func Infer(asserted []Statement, rules OntologyRules, limit int) ([]Inference, error) {
	if limit <= 0 {
		limit = defaultInferenceLimit
	}
	known := make(map[string]Statement, len(asserted))
	for _, statement := range asserted {
		if statement.ID == "" || statement.Subject == "" || statement.Predicate == "" {
			return nil, errors.New("assertions require id, subject, and predicate")
		}
		known[statementKey(statement)] = statement
	}
	var derived []Inference
	add := func(candidate Statement, rule string, parents ...string) (bool, error) {
		key := statementKey(candidate)
		if _, exists := known[key]; exists {
			return false, nil
		}
		if len(derived) >= limit {
			return false, errors.New("ontology inference limit exceeded")
		}
		candidate.ID = deterministicInferenceID(rule, key, parents)
		candidate.Inferred = true
		known[key] = candidate
		sortedParents := append([]string(nil), parents...)
		sort.Strings(sortedParents)
		derived = append(derived, Inference{Statement: candidate, RuleID: rule, ParentIDs: sortedParents})
		return true, nil
	}
	for changed := true; changed; {
		changed = false
		current := make([]Statement, 0, len(known))
		for _, statement := range known {
			current = append(current, statement)
		}
		sort.Slice(current, func(i, j int) bool { return current[i].ID < current[j].ID })
		for _, statement := range current {
			for _, parent := range rules.SubProperty[statement.Predicate] {
				candidate := statement
				candidate.ID = ""
				candidate.Predicate = parent
				added, err := add(candidate, "rdfs.subPropertyOf", statement.ID)
				if err != nil {
					return nil, err
				}
				changed = changed || added
			}
			if statement.Predicate == rdfNS+"type" && statement.Object.IRI != "" {
				for _, parent := range rules.SubClass[statement.Object.IRI] {
					candidate := statement
					candidate.ID = ""
					candidate.Object = RDFObject{IRI: parent}
					added, err := add(candidate, "rdfs.subClassOf", statement.ID)
					if err != nil {
						return nil, err
					}
					changed = changed || added
				}
			}
			for _, domain := range rules.Domain[statement.Predicate] {
				candidate := Statement{Subject: statement.Subject, Predicate: rdfNS + "type", Object: RDFObject{IRI: domain}, Qualifiers: cloneQualifiers(statement.Qualifiers), ValidFrom: statement.ValidFrom, ValidTo: statement.ValidTo}
				added, err := add(candidate, "rdfs.domain", statement.ID)
				if err != nil {
					return nil, err
				}
				changed = changed || added
			}
			if statement.Object.IRI != "" {
				for _, rangeIRI := range rules.Range[statement.Predicate] {
					candidate := Statement{Subject: statement.Object.IRI, Predicate: rdfNS + "type", Object: RDFObject{IRI: rangeIRI}, Qualifiers: cloneQualifiers(statement.Qualifiers), ValidFrom: statement.ValidFrom, ValidTo: statement.ValidTo}
					added, err := add(candidate, "rdfs.range", statement.ID)
					if err != nil {
						return nil, err
					}
					changed = changed || added
				}
				for _, inverse := range rules.Inverse[statement.Predicate] {
					candidate := Statement{Subject: statement.Object.IRI, Predicate: inverse, Object: RDFObject{IRI: statement.Subject}, Qualifiers: cloneQualifiers(statement.Qualifiers), ValidFrom: statement.ValidFrom, ValidTo: statement.ValidTo}
					added, err := add(candidate, "owl.inverseOf", statement.ID)
					if err != nil {
						return nil, err
					}
					changed = changed || added
				}
				if rules.Symmetric[statement.Predicate] {
					candidate := Statement{Subject: statement.Object.IRI, Predicate: statement.Predicate, Object: RDFObject{IRI: statement.Subject}, Qualifiers: cloneQualifiers(statement.Qualifiers), ValidFrom: statement.ValidFrom, ValidTo: statement.ValidTo}
					added, err := add(candidate, "owl.SymmetricProperty", statement.ID)
					if err != nil {
						return nil, err
					}
					changed = changed || added
				}
			}
		}
		for _, left := range current {
			if !rules.Transitive[left.Predicate] || left.Object.IRI == "" {
				continue
			}
			for _, right := range current {
				if right.Predicate != left.Predicate || right.Subject != left.Object.IRI || right.Object.IRI == "" || qualifierKey(left.Qualifiers) != qualifierKey(right.Qualifiers) {
					continue
				}
				candidate := Statement{Subject: left.Subject, Predicate: left.Predicate, Object: RDFObject{IRI: right.Object.IRI}, Qualifiers: cloneQualifiers(left.Qualifiers), ValidFrom: maxStart(left.ValidFrom, right.ValidFrom), ValidTo: minEnd(left.ValidTo, right.ValidTo)}
				if !validInterval(candidate.ValidFrom, candidate.ValidTo) {
					continue
				}
				added, err := add(candidate, "owl.TransitiveProperty", left.ID, right.ID)
				if err != nil {
					return nil, err
				}
				changed = changed || added
			}
		}
	}
	sort.Slice(derived, func(i, j int) bool { return derived[i].Statement.ID < derived[j].Statement.ID })
	return derived, nil
}

func DetectFunctionalConflicts(statements []Statement, rules OntologyRules) []Conflict {
	groups := map[string][]Statement{}
	for _, statement := range statements {
		if rules.Functional[statement.Predicate] {
			key := statement.Subject + "\x00" + statement.Predicate + "\x00" + qualifierKey(statement.Qualifiers)
			groups[key] = append(groups[key], statement)
		}
	}
	var conflicts []Conflict
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool { return group[i].ID < group[j].ID })
		for left := 0; left < len(group); left++ {
			for right := left + 1; right < len(group); right++ {
				if objectKey(group[left].Object) == objectKey(group[right].Object) || !intervalsOverlap(group[left], group[right]) {
					continue
				}
				conflicts = append(conflicts, Conflict{LeftID: group[left].ID, RightID: group[right].ID, Predicate: group[left].Predicate, Reason: "functional property has different values under identical qualifiers and overlapping validity"})
			}
		}
	}
	return conflicts
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
func cloneQualifiers(values map[string]RDFObject) map[string]RDFObject {
	if len(values) == 0 {
		return nil
	}
	copyValues := make(map[string]RDFObject, len(values))
	for key, value := range values {
		copyValues[key] = value
	}
	return copyValues
}
func objectKey(value RDFObject) string { data, _ := json.Marshal(value); return string(data) }
func qualifierKey(values map[string]RDFObject) string {
	if len(values) == 0 {
		return ""
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteByte('=')
		builder.WriteString(objectKey(values[key]))
		builder.WriteByte(';')
	}
	return builder.String()
}
func statementKey(value Statement) string {
	from, to := "", ""
	if value.ValidFrom != nil {
		from = core.CanonicalKnowledgeTime(*value.ValidFrom)
	}
	if value.ValidTo != nil {
		to = core.CanonicalKnowledgeTime(*value.ValidTo)
	}
	return strings.Join([]string{value.Subject, value.Predicate, objectKey(value.Object), qualifierKey(value.Qualifiers), from, to}, "\x00")
}
func deterministicInferenceID(rule, key string, parents []string) string {
	sorted := append([]string(nil), parents...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(rule + "\x00" + key + "\x00" + strings.Join(sorted, "\x00")))
	return "kinf_" + hex.EncodeToString(sum[:16])
}
func maxStart(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if left.After(*right) {
		return left
	}
	return right
}
func minEnd(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if left.Before(*right) {
		return left
	}
	return right
}
func validInterval(from, to *time.Time) bool { return from == nil || to == nil || !from.After(*to) }
func intervalsOverlap(left, right Statement) bool {
	return validInterval(maxStart(left.ValidFrom, right.ValidFrom), minEnd(left.ValidTo, right.ValidTo))
}

func ValidateSIValue(original string, siValue *float64, unit, dimension string, allowlist map[string]map[string]float64) error {
	if strings.TrimSpace(original) == "" {
		return errors.New("numeric original value is required")
	}
	if siValue == nil {
		return errors.New("normalized SI value is required")
	}
	if *siValue != *siValue || *siValue > 1.7976931348623157e308 || *siValue < -1.7976931348623157e308 {
		return errors.New("NaN and infinity are not valid normalized values")
	}
	units, ok := allowlist[dimension]
	if !ok {
		return fmt.Errorf("unsupported unit dimension %s", dimension)
	}
	if _, ok := units[unit]; !ok {
		return fmt.Errorf("unsupported unit %s for dimension %s", unit, dimension)
	}
	return nil
}

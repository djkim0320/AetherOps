package knowledge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxOntologyBytes = 16 << 20

const (
	rdfNS  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
	rdfsNS = "http://www.w3.org/2000/01/rdf-schema#"
	owlNS  = "http://www.w3.org/2002/07/owl#"
	xsdNS  = "http://www.w3.org/2001/XMLSchema#"
)

type RDFObject struct {
	IRI      string `json:"iri,omitempty"`
	Value    string `json:"value,omitempty"`
	Datatype string `json:"datatype,omitempty"`
	Language string `json:"language,omitempty"`
}

type RDFTriple struct {
	Subject   string    `json:"subject"`
	Predicate string    `json:"predicate"`
	Object    RDFObject `json:"object"`
}

type ParsedOntology struct {
	Format          string      `json:"format"`
	Triples         []RDFTriple `json:"triples"`
	CanonicalNQuads []byte      `json:"-"`
	SHA256          string      `json:"sha256"`
	TripleCount     int         `json:"triple_count"`
}

func ParseOntology(name, format string, data []byte) (ParsedOntology, error) {
	if len(data) == 0 || len(data) > MaxOntologyBytes {
		return ParsedOntology{}, errors.New("ontology must be between 1 byte and 16 MiB")
	}
	format = normalizeOntologyFormat(name, format)
	var triples []RDFTriple
	var err error
	switch format {
	case "turtle":
		triples, err = parseTurtle(data)
	case "jsonld":
		triples, err = parseJSONLD(data)
	case "rdfxml":
		triples, err = parseRDFXML(data)
	default:
		return ParsedOntology{}, errors.New("ontology format must be .ttl, .jsonld, .rdf, or .owl")
	}
	if err != nil {
		return ParsedOntology{}, err
	}
	if err := validateOntologyTriples(triples); err != nil {
		return ParsedOntology{}, err
	}
	canonical := canonicalNQuads(triples)
	sum := sha256.Sum256(canonical)
	return ParsedOntology{Format: format, Triples: triples, CanonicalNQuads: canonical,
		SHA256: hex.EncodeToString(sum[:]), TripleCount: len(triples)}, nil
}

func normalizeOntologyFormat(name, format string) string {
	value := strings.ToLower(strings.TrimSpace(format))
	switch value {
	case "ttl", ".ttl", "text/turtle", "turtle":
		return "turtle"
	case "jsonld", ".jsonld", "application/ld+json":
		return "jsonld"
	case "rdf", ".rdf", "owl", ".owl", "application/rdf+xml", "rdfxml", "rdf/xml":
		return "rdfxml"
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".ttl":
		return "turtle"
	case ".jsonld":
		return "jsonld"
	case ".rdf", ".owl":
		return "rdfxml"
	default:
		return value
	}
}

var allowedSchemaPredicates = map[string]struct{}{
	rdfNS + "type": {}, rdfsNS + "subClassOf": {}, rdfsNS + "subPropertyOf": {},
	rdfsNS + "domain": {}, rdfsNS + "range": {}, rdfsNS + "label": {}, rdfsNS + "comment": {},
	owlNS + "inverseOf": {},
}

var allowedTypes = map[string]struct{}{
	rdfsNS + "Class": {}, rdfNS + "Property": {}, owlNS + "Class": {}, owlNS + "Ontology": {},
	owlNS + "ObjectProperty": {}, owlNS + "DatatypeProperty": {}, owlNS + "AnnotationProperty": {},
	owlNS + "SymmetricProperty": {}, owlNS + "TransitiveProperty": {}, owlNS + "FunctionalProperty": {},
}

func validateOntologyTriples(triples []RDFTriple) error {
	if len(triples) == 0 {
		return errors.New("ontology contains no schema triples")
	}
	for _, triple := range triples {
		if triple.Subject == "" || strings.HasPrefix(triple.Subject, "_:") || triple.Predicate == "" {
			return errors.New("blank nodes and empty RDF terms are not supported in ontology schemas")
		}
		if triple.Object.IRI != "" && (triple.Object.Value != "" || triple.Object.Language != "" || triple.Object.Datatype != "") {
			return errors.New("ontology RDF objects cannot combine an IRI with literal fields")
		}
		if triple.Object.Language != "" && triple.Object.Datatype != "" {
			return errors.New("ontology RDF literals cannot combine a language and datatype")
		}
		if triple.Predicate == owlNS+"imports" {
			return errors.New("owl:imports is not supported; the entire import was rejected")
		}
		if _, ok := allowedSchemaPredicates[triple.Predicate]; !ok {
			return fmt.Errorf("unsupported ontology axiom predicate %s", triple.Predicate)
		}
		if triple.Predicate == rdfNS+"type" {
			if _, ok := allowedTypes[triple.Object.IRI]; !ok || triple.Object.Value != "" {
				return fmt.Errorf("unsupported rdf:type ontology term %s", triple.Object.IRI)
			}
			continue
		}
		if triple.Predicate == rdfsNS+"label" || triple.Predicate == rdfsNS+"comment" {
			if triple.Object.IRI != "" {
				return errors.New("ontology labels and comments must be literals")
			}
			continue
		}
		if triple.Object.IRI == "" || strings.HasPrefix(triple.Object.IRI, "_:") {
			return fmt.Errorf("ontology axiom %s requires an IRI object", triple.Predicate)
		}
	}
	return nil
}

func canonicalNQuads(triples []RDFTriple) []byte {
	unique := make(map[string]struct{}, len(triples))
	for _, triple := range triples {
		object := "<" + escapeIRI(triple.Object.IRI) + ">"
		if triple.Object.IRI == "" {
			object = strconvQuoteRDF(triple.Object.Value)
			if triple.Object.Language != "" {
				object += "@" + strings.ToLower(triple.Object.Language)
			}
			if triple.Object.Datatype != "" {
				object += "^^<" + escapeIRI(triple.Object.Datatype) + ">"
			}
		}
		unique["<"+escapeIRI(triple.Subject)+"> <"+escapeIRI(triple.Predicate)+"> "+object+" .\n"] = struct{}{}
	}
	lines := make([]string, 0, len(unique))
	for line := range unique {
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return []byte(strings.Join(lines, ""))
}

func escapeIRI(value string) string {
	return strings.NewReplacer(">", "%3E", "<", "%3C", " ", "%20").Replace(value)
}
func strconvQuoteRDF(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

type turtleToken struct{ kind, value, datatype, language string }

func parseTurtle(data []byte) ([]RDFTriple, error) {
	tokens, err := lexTurtle(string(data))
	if err != nil {
		return nil, err
	}
	prefixes := builtinPrefixes()
	position := 0
	for position < len(tokens) {
		if strings.EqualFold(tokens[position].value, "@prefix") || strings.EqualFold(tokens[position].value, "PREFIX") {
			position++
			if position+1 >= len(tokens) {
				return nil, errors.New("invalid Turtle prefix declaration")
			}
			name := strings.TrimSuffix(tokens[position].value, ":")
			position++
			if tokens[position].kind != "iri" {
				return nil, errors.New("Turtle prefix IRI is required")
			}
			prefixes[name] = tokens[position].value
			position++
			if position < len(tokens) && tokens[position].value == "." {
				position++
			}
			continue
		}
		if strings.EqualFold(tokens[position].value, "@base") || strings.EqualFold(tokens[position].value, "BASE") {
			return nil, errors.New("Turtle base directives are not supported; use absolute IRIs")
		}
		break
	}
	var triples []RDFTriple
	for position < len(tokens) {
		subject, next, err := turtleIRI(tokens, position, prefixes)
		if err != nil {
			return nil, err
		}
		position = next
		for {
			if position >= len(tokens) {
				return nil, errors.New("Turtle predicate is missing")
			}
			predicate := ""
			if tokens[position].value == "a" {
				predicate = rdfNS + "type"
				position++
			} else {
				predicate, position, err = turtleIRI(tokens, position, prefixes)
				if err != nil {
					return nil, err
				}
			}
			for {
				if position >= len(tokens) {
					return nil, errors.New("Turtle object is missing")
				}
				object := RDFObject{}
				if tokens[position].kind == "literal" {
					object.Value, object.Language = tokens[position].value, tokens[position].language
					if tokens[position].datatype != "" {
						object.Datatype, err = expandQName(tokens[position].datatype, prefixes)
						if err != nil {
							return nil, err
						}
					}
					position++
				} else {
					object.IRI, position, err = turtleIRI(tokens, position, prefixes)
					if err != nil {
						return nil, err
					}
				}
				triples = append(triples, RDFTriple{Subject: subject, Predicate: predicate, Object: object})
				if position < len(tokens) && tokens[position].value == "," {
					position++
					continue
				}
				break
			}
			if position < len(tokens) && tokens[position].value == ";" {
				position++
				if position < len(tokens) && tokens[position].value == "." {
					position++
					break
				}
				continue
			}
			if position >= len(tokens) || tokens[position].value != "." {
				return nil, errors.New("Turtle statement must end with a period")
			}
			position++
			break
		}
	}
	return triples, nil
}

func builtinPrefixes() map[string]string {
	return map[string]string{"rdf": rdfNS, "rdfs": rdfsNS, "owl": owlNS, "xsd": xsdNS}
}
func turtleIRI(tokens []turtleToken, position int, prefixes map[string]string) (string, int, error) {
	if position >= len(tokens) {
		return "", position, io.ErrUnexpectedEOF
	}
	if tokens[position].kind == "iri" {
		return tokens[position].value, position + 1, nil
	}
	value, err := expandQName(tokens[position].value, prefixes)
	return value, position + 1, err
}
func expandQName(value string, prefixes map[string]string) (string, error) {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "urn:") {
		return value, nil
	}
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 || strings.HasPrefix(value, "_:") {
		return "", fmt.Errorf("absolute IRI or declared QName required: %s", value)
	}
	base, ok := prefixes[parts[0]]
	if !ok {
		return "", fmt.Errorf("undeclared Turtle prefix %s", parts[0])
	}
	return base + parts[1], nil
}

func lexTurtle(value string) ([]turtleToken, error) {
	if !utf8.ValidString(value) {
		return nil, errors.New("Turtle input must be valid UTF-8")
	}
	var tokens []turtleToken
	for index := 0; index < len(value); {
		if unicode.IsSpace(rune(value[index])) {
			index++
			continue
		}
		if value[index] == '#' {
			for index < len(value) && value[index] != '\n' {
				index++
			}
			continue
		}
		if strings.ContainsRune(".;,", rune(value[index])) {
			tokens = append(tokens, turtleToken{kind: "punct", value: string(value[index])})
			index++
			continue
		}
		if value[index] == '[' || value[index] == ']' || strings.HasPrefix(value[index:], "_:") {
			return nil, errors.New("Turtle blank nodes are not supported")
		}
		if value[index] == '<' {
			iri, next, err := lexTurtleIRI(value, index)
			if err != nil {
				return nil, err
			}
			tokens = append(tokens, turtleToken{kind: "iri", value: iri})
			index = next
			continue
		}
		if value[index] == '"' || value[index] == '\'' {
			quote := value[index]
			if index+2 < len(value) && value[index+1] == quote && value[index+2] == quote {
				return nil, errors.New("Turtle long string literals are not supported")
			}
			index++
			var builder strings.Builder
			closed := false
			for index < len(value) {
				if value[index] == '\\' {
					decoded, next, err := decodeTurtleStringEscape(value, index)
					if err != nil {
						return nil, err
					}
					builder.WriteRune(decoded)
					index = next
					continue
				}
				if value[index] == '\n' || value[index] == '\r' {
					return nil, errors.New("unescaped newline in Turtle short string literal")
				}
				if value[index] == quote {
					index++
					closed = true
					break
				}
				builder.WriteByte(value[index])
				index++
			}
			if !closed {
				return nil, errors.New("unterminated Turtle literal")
			}
			token := turtleToken{kind: "literal", value: builder.String()}
			if index < len(value) && value[index] == '@' {
				start := index + 1
				index = start
				for index < len(value) && (unicode.IsLetter(rune(value[index])) || value[index] == '-') {
					index++
				}
				token.language = value[start:index]
			}
			if strings.HasPrefix(value[index:], "^^") {
				if token.language != "" {
					return nil, errors.New("Turtle literal cannot have both a language tag and a datatype")
				}
				index += 2
				start := index
				if index < len(value) && value[index] == '<' {
					var err error
					token.datatype, index, err = lexTurtleIRI(value, index)
					if err != nil {
						return nil, fmt.Errorf("Turtle literal datatype: %w", err)
					}
				} else {
					for index < len(value) && !unicode.IsSpace(rune(value[index])) && !strings.ContainsRune(".;,", rune(value[index])) {
						index++
					}
					token.datatype = value[start:index]
					if strings.Contains(token.datatype, "\\") {
						return nil, errors.New("escaped Turtle datatype QName is not supported")
					}
				}
			}
			tokens = append(tokens, token)
			continue
		}
		var builder strings.Builder
		for index < len(value) && !unicode.IsSpace(rune(value[index])) && !strings.ContainsRune(".;,<>'\"", rune(value[index])) {
			if value[index] == '\\' {
				if index+1 >= len(value) || !strings.ContainsRune("_~.-!$&'()*+,;=/?#@%", rune(value[index+1])) {
					return nil, errors.New("unsupported or invalid Turtle prefixed-name escape")
				}
				builder.WriteByte(value[index+1])
				index += 2
				continue
			}
			builder.WriteByte(value[index])
			index++
		}
		if builder.Len() == 0 {
			return nil, fmt.Errorf("unexpected Turtle token %q", value[index])
		}
		tokens = append(tokens, turtleToken{kind: "word", value: builder.String()})
	}
	return tokens, nil
}

func lexTurtleIRI(value string, index int) (string, int, error) {
	if index >= len(value) || value[index] != '<' {
		return "", index, errors.New("Turtle IRI must start with '<'")
	}
	index++
	var builder strings.Builder
	for index < len(value) {
		if value[index] == '>' {
			return builder.String(), index + 1, nil
		}
		if value[index] == '\\' {
			decoded, next, err := decodeTurtleUnicodeEscape(value, index)
			if err != nil {
				return "", index, fmt.Errorf("invalid Turtle IRI escape: %w", err)
			}
			builder.WriteRune(decoded)
			index = next
			continue
		}
		decoded, size := utf8.DecodeRuneInString(value[index:])
		if decoded == utf8.RuneError && size == 1 {
			return "", index, errors.New("Turtle IRI contains invalid UTF-8")
		}
		if decoded <= 0x20 || strings.ContainsRune("<>\"{}|^`", decoded) {
			return "", index, fmt.Errorf("Turtle IRI contains forbidden character %q", decoded)
		}
		builder.WriteRune(decoded)
		index += size
	}
	return "", index, errors.New("unterminated Turtle IRI")
}

func decodeTurtleStringEscape(value string, index int) (rune, int, error) {
	if index+1 >= len(value) || value[index] != '\\' {
		return 0, index, errors.New("unterminated Turtle string escape")
	}
	switch value[index+1] {
	case 't':
		return '\t', index + 2, nil
	case 'b':
		return '\b', index + 2, nil
	case 'n':
		return '\n', index + 2, nil
	case 'r':
		return '\r', index + 2, nil
	case 'f':
		return '\f', index + 2, nil
	case '"':
		return '"', index + 2, nil
	case '\'':
		return '\'', index + 2, nil
	case '\\':
		return '\\', index + 2, nil
	case 'u', 'U':
		return decodeTurtleUnicodeEscape(value, index)
	default:
		return 0, index, fmt.Errorf("unsupported Turtle string escape \\%c", value[index+1])
	}
}

func decodeTurtleUnicodeEscape(value string, index int) (rune, int, error) {
	if index+1 >= len(value) || value[index] != '\\' {
		return 0, index, errors.New("Turtle Unicode escape must start with a backslash")
	}
	digits := 0
	switch value[index+1] {
	case 'u':
		digits = 4
	case 'U':
		digits = 8
	default:
		return 0, index, errors.New("Turtle IRI escapes must use \\u or \\U")
	}
	end := index + 2 + digits
	if end > len(value) {
		return 0, index, errors.New("truncated Turtle Unicode escape")
	}
	encoded := value[index+2 : end]
	for _, digit := range encoded {
		if !strings.ContainsRune("0123456789abcdefABCDEF", digit) {
			return 0, index, fmt.Errorf("invalid hexadecimal Turtle Unicode escape %q", encoded)
		}
	}
	codepoint, err := strconv.ParseUint(encoded, 16, 32)
	if err != nil {
		return 0, index, fmt.Errorf("parse Turtle Unicode escape: %w", err)
	}
	decoded := rune(codepoint)
	if !utf8.ValidRune(decoded) {
		return 0, index, fmt.Errorf("Turtle Unicode escape is not a Unicode scalar value: U+%X", codepoint)
	}
	return decoded, end, nil
}

func parseJSONLD(data []byte) ([]RDFTriple, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root any
	if err := decoder.Decode(&root); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("JSON-LD ontology contains multiple JSON values")
		}
		return nil, err
	}
	objects, ok := root.(map[string]any)
	if !ok {
		return nil, errors.New("JSON-LD root must be an object")
	}
	contextMap := builtinPrefixes()
	if contextValue, exists := objects["@context"]; exists {
		if err := readJSONLDContext(contextValue, contextMap); err != nil {
			return nil, err
		}
	}
	nodes := []any{objects}
	graphNodes := false
	if graph, exists := objects["@graph"]; exists {
		for key := range objects {
			if key != "@context" && key != "@graph" {
				return nil, fmt.Errorf("unsupported JSON-LD graph wrapper member %s", key)
			}
		}
		list, ok := graph.([]any)
		if !ok {
			return nil, errors.New("JSON-LD @graph must be an array")
		}
		nodes = list
		graphNodes = true
	}
	var triples []RDFTriple
	for _, raw := range nodes {
		node, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("JSON-LD graph nodes must be objects")
		}
		if _, scopedContext := node["@context"]; scopedContext && graphNodes {
			return nil, errors.New("scoped JSON-LD contexts are not supported; the entire import was rejected")
		}
		subject, ok := node["@id"].(string)
		if !ok || strings.TrimSpace(subject) == "" {
			return nil, errors.New("JSON-LD schema nodes require a string @id")
		}
		expandedSubject, err := expandJSONLDTerm(subject, contextMap)
		if err != nil {
			return nil, err
		}
		for key, value := range node {
			if strings.HasPrefix(key, "@") {
				switch key {
				case "@context", "@id":
					continue
				case "@type":
					values := jsonLDValues(value)
					for _, item := range values {
						name, ok := item.(string)
						if !ok {
							return nil, errors.New("JSON-LD @type must contain strings")
						}
						iri, err := expandJSONLDTerm(name, contextMap)
						if err != nil {
							return nil, err
						}
						triples = append(triples, RDFTriple{Subject: expandedSubject, Predicate: rdfNS + "type", Object: RDFObject{IRI: iri}})
					}
					continue
				default:
					return nil, fmt.Errorf("unsupported JSON-LD node keyword %s", key)
				}
			}
			predicate, err := expandJSONLDTerm(key, contextMap)
			if err != nil {
				return nil, err
			}
			for _, item := range jsonLDValues(value) {
				object, err := jsonLDObject(item, contextMap)
				if err != nil {
					return nil, err
				}
				triples = append(triples, RDFTriple{Subject: expandedSubject, Predicate: predicate, Object: object})
			}
		}
	}
	return triples, nil
}
func readJSONLDContext(value any, prefixes map[string]string) error {
	switch typed := value.(type) {
	case string:
		return errors.New("remote JSON-LD contexts are not allowed")
	case []any:
		for _, item := range typed {
			if err := readJSONLDContext(item, prefixes); err != nil {
				return err
			}
		}
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		definitions := make(map[string]string, len(keys))
		for _, key := range keys {
			raw := typed[key]
			if key == "@import" {
				return errors.New("remote JSON-LD context imports are not allowed")
			}
			if strings.HasPrefix(key, "@") {
				return fmt.Errorf("unsupported JSON-LD context directive %s", key)
			}
			switch v := raw.(type) {
			case string:
				definitions[key] = v
			case map[string]any:
				for option := range v {
					if option != "@id" {
						return errors.New("scoped or extended JSON-LD context terms are not supported")
					}
				}
				id, _ := v["@id"].(string)
				if id == "" {
					return errors.New("JSON-LD context term requires @id")
				}
				definitions[key] = id
			default:
				return errors.New("unsupported JSON-LD context entry")
			}
		}
		// Resolve the context in two deterministic passes. Direct absolute IRI
		// definitions establish the prefix vocabulary first; compact term
		// definitions can then reference those prefixes regardless of JSON object
		// or Go map iteration order.
		resolved := make(map[string]string, len(definitions))
		for _, key := range keys {
			definition, exists := definitions[key]
			if exists && isAbsoluteIRI(definition) {
				resolved[key] = definition
				prefixes[key] = definition
			}
		}
		for _, key := range keys {
			definition, exists := definitions[key]
			if !exists || isAbsoluteIRI(definition) {
				continue
			}
			expanded, err := expandJSONLDTerm(definition, prefixes)
			if err != nil {
				return fmt.Errorf("JSON-LD context term %s: %w", key, err)
			}
			resolved[key] = expanded
		}
		for _, key := range keys {
			if expanded, exists := resolved[key]; exists {
				prefixes[key] = expanded
			}
		}
	default:
		return errors.New("JSON-LD @context must be a local object")
	}
	return nil
}
func jsonLDValues(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return []any{value}
}
func expandJSONLDTerm(value string, prefixes map[string]string) (string, error) {
	if value == "" || strings.HasPrefix(value, "_:") {
		return "", errors.New("JSON-LD blank or missing @id is not supported")
	}
	if isAbsoluteIRI(value) {
		return value, nil
	}
	if mapped, ok := prefixes[value]; ok {
		return mapped, nil
	}
	return expandQName(value, prefixes)
}

func isAbsoluteIRI(value string) bool {
	return strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "urn:")
}
func jsonLDObject(value any, prefixes map[string]string) (RDFObject, error) {
	switch typed := value.(type) {
	case string:
		return RDFObject{Value: typed}, nil
	case map[string]any:
		if _, scopedContext := typed["@context"]; scopedContext {
			return RDFObject{}, errors.New("scoped JSON-LD contexts are not supported; the entire import was rejected")
		}
		idValue, hasID := typed["@id"]
		_, hasValue := typed["@value"]
		if hasID && hasValue {
			return RDFObject{}, errors.New("JSON-LD object cannot combine @id and @value")
		}
		if hasID {
			if len(typed) != 1 {
				return RDFObject{}, errors.New("JSON-LD @id objects cannot contain literal or unsupported members")
			}
			id, ok := idValue.(string)
			if !ok || strings.TrimSpace(id) == "" {
				return RDFObject{}, errors.New("JSON-LD object @id must be a non-empty string")
			}
			iri, err := expandJSONLDTerm(id, prefixes)
			return RDFObject{IRI: iri}, err
		}
		for key := range typed {
			if key != "@value" && key != "@language" && key != "@type" {
				return RDFObject{}, fmt.Errorf("unsupported JSON-LD literal keyword %s", key)
			}
		}
		literal, ok := typed["@value"].(string)
		if !ok {
			return RDFObject{}, errors.New("JSON-LD object must use @id or string @value")
		}
		object := RDFObject{Value: literal}
		if rawLanguage, exists := typed["@language"]; exists {
			language, ok := rawLanguage.(string)
			if !ok || strings.TrimSpace(language) == "" {
				return RDFObject{}, errors.New("JSON-LD @language must be a non-empty string")
			}
			object.Language = language
		}
		if rawDatatype, exists := typed["@type"]; exists {
			datatype, ok := rawDatatype.(string)
			if !ok || strings.TrimSpace(datatype) == "" {
				return RDFObject{}, errors.New("JSON-LD literal @type must be a non-empty string")
			}
			expanded, err := expandJSONLDTerm(datatype, prefixes)
			if err != nil {
				return RDFObject{}, err
			}
			object.Datatype = expanded
		}
		if object.Language != "" && object.Datatype != "" {
			return RDFObject{}, errors.New("JSON-LD literal cannot combine @language and @type")
		}
		return object, nil
	default:
		return RDFObject{}, errors.New("unsupported JSON-LD object value")
	}
}

func parseRDFXML(data []byte) ([]RDFTriple, error) {
	lower := bytes.ToLower(data)
	if bytes.Contains(lower, []byte("<!doctype")) || bytes.Contains(lower, []byte("<!entity")) {
		return nil, errors.New("RDF/XML DTD and entities are not allowed")
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var triples []RDFTriple
	depth := 0
	subject := ""
	var predicate string
	var literal strings.Builder
	var current RDFObject
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			depth++
			if depth == 1 {
				if typed.Name.Space+typed.Name.Local != rdfNS+"RDF" {
					return nil, errors.New("RDF/XML root must be rdf:RDF")
				}
				continue
			}
			if depth == 2 {
				for _, attribute := range typed.Attr {
					if isXMLNamespaceDeclaration(attribute) {
						continue
					}
					if attribute.Name.Space+attribute.Name.Local != rdfNS+"about" {
						return nil, fmt.Errorf("unsupported RDF/XML node attribute %s", attribute.Name.Local)
					}
				}
				subject = xmlAttr(typed.Attr, rdfNS+"about")
				if subject == "" || strings.HasPrefix(subject, "_:") {
					return nil, errors.New("RDF/XML nodes require rdf:about IRI")
				}
				elementType := typed.Name.Space + typed.Name.Local
				if elementType != rdfNS+"Description" {
					triples = append(triples, RDFTriple{Subject: subject, Predicate: rdfNS + "type", Object: RDFObject{IRI: elementType}})
				}
				continue
			}
			if depth == 3 {
				predicate = typed.Name.Space + typed.Name.Local
				current = RDFObject{}
				attributeKinds := 0
				for _, attribute := range typed.Attr {
					if isXMLNamespaceDeclaration(attribute) {
						continue
					}
					expanded := attribute.Name.Space + attribute.Name.Local
					switch expanded {
					case rdfNS + "resource":
						if strings.TrimSpace(attribute.Value) == "" {
							return nil, errors.New("RDF/XML rdf:resource must be non-empty")
						}
						current.IRI = attribute.Value
						attributeKinds++
					case rdfNS + "datatype":
						if strings.TrimSpace(attribute.Value) == "" {
							return nil, errors.New("RDF/XML rdf:datatype must be non-empty")
						}
						current.Datatype = attribute.Value
						attributeKinds++
					case "http://www.w3.org/XML/1998/namespace" + "lang":
						if strings.TrimSpace(attribute.Value) == "" {
							return nil, errors.New("RDF/XML xml:lang must be non-empty")
						}
						current.Language = attribute.Value
						attributeKinds++
					default:
						return nil, fmt.Errorf("unsupported RDF/XML property attribute %s", attribute.Name.Local)
					}
				}
				if attributeKinds > 1 {
					return nil, errors.New("RDF/XML property cannot combine rdf:resource, rdf:datatype, or xml:lang")
				}
				literal.Reset()
				continue
			}
			return nil, errors.New("nested RDF/XML resource nodes are not supported")
		case xml.CharData:
			if depth == 3 {
				literal.Write([]byte(typed))
			}
		case xml.EndElement:
			if depth == 3 {
				if current.IRI != "" {
					if strings.TrimSpace(literal.String()) != "" {
						return nil, errors.New("RDF/XML rdf:resource property cannot contain literal text")
					}
				} else {
					current.Value = literal.String()
				}
				triples = append(triples, RDFTriple{Subject: subject, Predicate: predicate, Object: current})
			}
			depth--
		}
	}
	return triples, nil
}
func isXMLNamespaceDeclaration(attribute xml.Attr) bool {
	return attribute.Name.Space == "xmlns" || (attribute.Name.Space == "" && attribute.Name.Local == "xmlns")
}
func xmlAttr(attributes []xml.Attr, expanded string) string {
	for _, attribute := range attributes {
		if attribute.Name.Space+attribute.Name.Local == expanded {
			return attribute.Value
		}
	}
	return ""
}

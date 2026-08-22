package knowledge

import (
	"errors"
	"strings"
	"unicode"
)

const MaxSPARQLQueryBytes = 64 << 10

var forbiddenSPARQLKeywords = map[string]struct{}{
	"ADD": {}, "CLEAR": {}, "COPY": {}, "CREATE": {}, "DELETE": {},
	"DROP": {}, "FROM": {}, "INSERT": {}, "LOAD": {}, "MOVE": {},
	"SERVICE": {}, "USING": {}, "WITH": {},
}

var queryForms = map[string]struct{}{
	"ASK": {}, "CONSTRUCT": {}, "DESCRIBE": {}, "SELECT": {},
}

// ValidateReadOnlySPARQL performs a fail-closed lexical gate before a query is
// sent to Oxigraph. Literals, comments, IRIs, variables, and prefixed names are
// kept out of keyword matching so text such as "DELETE" cannot cause a false
// positive while SERVICE and every SPARQL Update form remain blocked.
func ValidateReadOnlySPARQL(query string) error {
	_, err := ReadOnlySPARQLQueryForm(query)
	return err
}

// ReadOnlySPARQLQueryForm validates the complete fail-closed query contract
// and returns the top-level form used by the public SPARQLResult envelope.
func ReadOnlySPARQLQueryForm(query string) (string, error) {
	// The byte limit applies to the complete request, including comments and
	// padding. Trimming before measuring would let a direct caller bypass the
	// same bound enforced by the HTTP, MCP, and Node protocol surfaces.
	if query == "" || len(query) > MaxSPARQLQueryBytes {
		return "", errors.New("SPARQL query must be between 1 byte and 64 KiB")
	}
	query = strings.TrimSpace(strings.TrimPrefix(query, "\uFEFF"))
	if query == "" {
		return "", errors.New("SPARQL query must be between 1 byte and 64 KiB")
	}
	sanitized, err := stripSPARQLQuoted(query)
	if err != nil {
		return "", err
	}
	tokens := strings.FieldsFunc(sanitized, func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune("{}();,.[]", r)
	})
	form := ""
	for _, token := range tokens {
		token = strings.TrimSpace(token)
		if token == "" || strings.HasPrefix(token, "?") || strings.HasPrefix(token, "$") {
			continue
		}
		upper := strings.ToUpper(token)
		if _, blocked := forbiddenSPARQLKeywords[upper]; blocked {
			return "", errors.New("SPARQL Update, federation, and external datasets are not allowed")
		}
		if _, ok := queryForms[upper]; ok {
			if form == "" {
				form = upper
			}
			continue
		}
		if form == "" {
			// A QueryUnit may contain only BASE/PREFIX declarations before its
			// top-level query form. Prefix labels contain a colon and are ignored
			// here; arbitrary leading operations are rejected rather than left to
			// implementation-specific parser extensions.
			if upper == "BASE" || upper == "PREFIX" || strings.Contains(token, ":") {
				continue
			}
			return "", errors.New("SPARQL query must begin with SELECT, ASK, CONSTRUCT, or DESCRIBE after its prologue")
		}
	}
	if form == "" {
		return "", errors.New("SPARQL query must use SELECT, ASK, CONSTRUCT, or DESCRIBE")
	}
	return form, nil
}

func stripSPARQLQuoted(value string) (string, error) {
	data := []byte(value)
	out := make([]byte, len(data))
	copy(out, data)
	for index := 0; index < len(data); {
		switch data[index] {
		case '#':
			for index < len(data) && data[index] != '\n' {
				out[index] = ' '
				index++
			}
		case '<':
			if sparqlLessThanOperator(data, index) {
				index++
				continue
			}
			start := index
			index++
			for index < len(data) && data[index] != '>' {
				if data[index] == '\\' {
					index++
				}
				index++
			}
			if index >= len(data) {
				return "", errors.New("unterminated SPARQL IRI")
			}
			index++
			for cursor := start; cursor < index; cursor++ {
				out[cursor] = ' '
			}
		case '\'', '"':
			quote := data[index]
			start := index
			triple := index+2 < len(data) && data[index+1] == quote && data[index+2] == quote
			if triple {
				index += 3
			} else {
				index++
			}
			closed := false
			for index < len(data) {
				if data[index] == '\\' {
					index += 2
					continue
				}
				if triple && index+2 < len(data) && data[index] == quote && data[index+1] == quote && data[index+2] == quote {
					index += 3
					closed = true
					break
				}
				if !triple && data[index] == quote {
					index++
					closed = true
					break
				}
				index++
			}
			if !closed {
				return "", errors.New("unterminated SPARQL string")
			}
			for cursor := start; cursor < index && cursor < len(out); cursor++ {
				out[cursor] = ' '
			}
		default:
			index++
		}
	}
	return string(out), nil
}

func sparqlLessThanOperator(data []byte, index int) bool {
	if index+1 >= len(data) {
		return true
	}
	next := data[index+1]
	return next == '=' || next == '?' || next == '$' || next == '(' || next == '+' || next == '-' ||
		next == '.' || (next >= '0' && next <= '9') || unicode.IsSpace(rune(next))
}

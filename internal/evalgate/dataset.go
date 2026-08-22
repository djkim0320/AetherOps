package evalgate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

const DatasetSchemaV1 = 1

var caseIDPattern = regexp.MustCompile(`^(general|engineering)-[0-9]{2}$`)

type QualityPolicy struct {
	CitationIntegrityPercent int     `json:"citationIntegrityPercent"`
	MaxCriticalErrors        int     `json:"maxCriticalErrors"`
	MinimumAverageScore      float64 `json:"minimumAverageScore"`
	MinimumAxisScore         int     `json:"minimumAxisScore"`
}

type ReleaseGate struct {
	RequiredCases  int           `json:"requiredCases"`
	RequiredPasses int           `json:"requiredPasses"`
	QualityPolicy  QualityPolicy `json:"qualityPolicy"`
}

type Case struct {
	ID           string   `json:"id"`
	Mode         string   `json:"mode"`
	Question     string   `json:"question"`
	Requirements []string `json:"requirements"`
}

type Dataset struct {
	Schema      int         `json:"schema"`
	Name        string      `json:"name"`
	ReleaseGate ReleaseGate `json:"releaseGate"`
	Cases       []Case      `json:"cases"`
	SHA256      string      `json:"-"`
}

func LoadDataset(path string) (Dataset, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Dataset{}, err
	}
	var dataset Dataset
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&dataset); err != nil {
		return Dataset{}, fmt.Errorf("decode evaluation dataset: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Dataset{}, errors.New("evaluation dataset contains multiple JSON values")
		}
		return Dataset{}, fmt.Errorf("decode evaluation dataset trailer: %w", err)
	}
	digest := sha256.Sum256(raw)
	dataset.SHA256 = hex.EncodeToString(digest[:])
	if err := dataset.Validate(); err != nil {
		return Dataset{}, err
	}
	return dataset, nil
}

func (dataset Dataset) Validate() error {
	if dataset.Schema != DatasetSchemaV1 || strings.TrimSpace(dataset.Name) == "" {
		return errors.New("evaluation dataset schema and name are required")
	}
	gate := dataset.ReleaseGate
	if gate.RequiredCases != 12 || gate.RequiredPasses != 12 || len(dataset.Cases) != 12 {
		return errors.New("release evaluation dataset must require exactly 12 of 12 cases")
	}
	policy := gate.QualityPolicy
	if policy.CitationIntegrityPercent != 100 || policy.MaxCriticalErrors != 0 ||
		policy.MinimumAverageScore != 4 || policy.MinimumAxisScore != 3 {
		return errors.New("release evaluation quality policy differs from the product quality gate")
	}
	seen := make(map[string]struct{}, len(dataset.Cases))
	modes := map[string]int{"general": 0, "engineering": 0}
	for index, item := range dataset.Cases {
		if !caseIDPattern.MatchString(item.ID) || item.Mode != strings.SplitN(item.ID, "-", 2)[0] {
			return fmt.Errorf("evaluation case %d has an invalid id or mode", index+1)
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return fmt.Errorf("evaluation case id %q is duplicated", item.ID)
		}
		seen[item.ID] = struct{}{}
		if strings.TrimSpace(item.Question) == "" || len(item.Requirements) == 0 {
			return fmt.Errorf("evaluation case %q requires a question and acceptance requirements", item.ID)
		}
		for _, requirement := range item.Requirements {
			if strings.TrimSpace(requirement) == "" {
				return fmt.Errorf("evaluation case %q has an empty acceptance requirement", item.ID)
			}
		}
		modes[item.Mode]++
	}
	if modes["general"] != 6 || modes["engineering"] != 6 {
		return fmt.Errorf("release dataset must contain six general and six engineering cases, got %d/%d", modes["general"], modes["engineering"])
	}
	return nil
}

func (item Case) Prompt() string {
	var prompt strings.Builder
	prompt.WriteString(strings.TrimSpace(item.Question))
	prompt.WriteString("\n\n이 릴리스 평가의 필수 충족 조건:\n")
	for _, requirement := range item.Requirements {
		prompt.WriteString("- ")
		prompt.WriteString(strings.TrimSpace(requirement))
		prompt.WriteByte('\n')
	}
	prompt.WriteString("각 조건의 충족 여부를 최종 보고서에서 검증 가능하게 드러내세요.")
	return prompt.String()
}

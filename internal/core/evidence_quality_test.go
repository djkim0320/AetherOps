package core

import (
	"strings"
	"testing"
	"time"
)

func TestValidateEvidenceSourceContentRejectsJunkAndShellWrappers(t *testing.T) {
	source := EvidenceSource{ID: "source", URL: "https://example.test/source"}
	tests := []struct {
		name    string
		content []byte
		want    string
	}{
		{name: "one byte", content: []byte("x"), want: "too small"},
		{name: "one meaningful byte", content: []byte(" \r\nx\n"), want: "too small"},
		{name: "two bytes", content: []byte("xy"), want: "too small"},
		{name: "thirty one bytes", content: []byte(strings.Repeat("x", 31)), want: "too small"},
		{name: "exact minimum", content: []byte(strings.Repeat("x", 32))},
		{name: "powershell wrapper", content: []byte("Exit code: 0\nWall time: 1.4 seconds\nOutput:\n<html>source</html>"), want: "shell tool wrapper"},
		{name: "powershell web response", content: []byte("StatusCode : 200\nStatusDescription : OK\nContent : <html>source</html>\nRawContent : HTTP/1.1 200 OK"), want: "shell tool wrapper"},
		{name: "codex shell wrapper", content: []byte("Chunk ID: abc123\nWall time: 0.2 seconds\nProcess exited with code 0\nFinal output:\nsource"), want: "shell tool wrapper"},
		{name: "actual source", content: []byte("<html><body>primary source content</body></html>")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateEvidenceSourceContent(source, test.content)
			if test.want == "" {
				if err != nil {
					t.Fatalf("valid source content rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q rejection", err, test.want)
			}
		})
	}
}

func TestValidateEvidenceSourceContentDoesNotApplyPublicSourceHeuristicsToEngineeringReceipt(t *testing.T) {
	source, err := EngineeringReceiptEvidenceSource(
		"art_0123456789abcdef0123456789abcdef", "xfoil_polar", strings.Repeat("a", 64),
		time.Date(2026, time.August, 10, 0, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvidenceSourceContent(source, []byte("x")); err != nil {
		t.Fatalf("typed engineering receipt was treated as public source bytes: %v", err)
	}
}

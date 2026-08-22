package core

import (
	"bytes"
	"fmt"
	"net/url"
	"regexp"
)

const (
	minimumPublicEvidenceBytes = 32
	shellWrapperScanLimit      = 8 << 10
)

var shellWrapperMetadataLine = regexp.MustCompile(
	`(?im)^[\t ]*(?:chunk[\t ]+id|exit[\t ]+code|(?:process|command)[\t ]+exited[\t ]+with[\t ]+code|wall[\t ]+time):[^\r\n]*$`,
)

var (
	powerShellStatusLine = regexp.MustCompile(`(?im)^[\t ]*statuscode[\t ]*:[\t ]*[1-5][0-9]{2}[\t ]*$`)
	powerShellBodyLine   = regexp.MustCompile(`(?im)^[\t ]*(?:statusdescription|content|rawcontent|rawcontentlength)[\t ]*:`)
)

// ValidateEvidenceSourceContent validates the bytes behind an already
// provenance-bound EvidenceSource. Public citations must contain actual source
// bytes, not a placeholder byte or the command-runner envelope that happened
// to surround a shell downloader's stdout. Engineering receipt URNs are
// intentionally excluded: their typed receipt contract is verified against
// the run-owned engineering tables and CAS separately.
func ValidateEvidenceSourceContent(source EvidenceSource, content []byte) error {
	if _, receiptSource := EngineeringReceiptArtifactID(source); receiptSource {
		return nil
	}
	parsed, err := url.Parse(source.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return fmt.Errorf("evidence source %q is neither a public URL nor an engineering receipt", source.ID)
	}
	meaningful := bytes.TrimSpace(content)
	if len(meaningful) < minimumPublicEvidenceBytes {
		return fmt.Errorf("public evidence source %q is too small to contain source content (minimum %d bytes)", source.ID, minimumPublicEvidenceBytes)
	}
	scan := meaningful
	if len(scan) > shellWrapperScanLimit {
		scan = scan[:shellWrapperScanLimit]
	}
	// Command tool envelopes are UTF-8/ASCII metadata. Converting an arbitrary
	// binary prefix to string preserves bytes and cannot manufacture a matching
	// ASCII metadata line.
	scannedText := string(scan)
	if shellWrapperMetadataLine.MatchString(scannedText) ||
		(powerShellStatusLine.MatchString(scannedText) && powerShellBodyLine.MatchString(scannedText)) {
		return fmt.Errorf("public evidence source %q contains shell tool wrapper metadata", source.ID)
	}
	return nil
}

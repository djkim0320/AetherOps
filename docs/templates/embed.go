// Package templates embeds the reviewed AetherOps document templates into the
// single application executable. The DOCX file remains the design authority;
// reportdocx only replaces its documented content slots.
package templates

import _ "embed"

// AetherOpsResearchReportTemplate is the immutable Word reference used for
// every adopted research report document.
//
//go:embed AetherOps_Research_Report_Template.docx
var AetherOpsResearchReportTemplate []byte

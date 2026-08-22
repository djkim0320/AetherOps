package cleanvmevidence

import (
	"strings"

	"github.com/djkim0320/Aether-claw/internal/cleanvmcontract"
)

const (
	HostReferenceSchemaV1 = cleanvmcontract.HostReferenceSchemaV1
	DetailsSchemaV1       = cleanvmcontract.DetailsSchemaV1
	ProducerName          = cleanvmcontract.ProducerName
	ProducerVersion       = cleanvmcontract.ProducerVersion
	ScenarioInstaller     = cleanvmcontract.ScenarioInstaller
	ScenarioPortable      = cleanvmcontract.ScenarioPortable
)

type HostReference = cleanvmcontract.HostReference
type VMEnvironment = cleanvmcontract.VMEnvironment
type PackageObservation = cleanvmcontract.PackageObservation
type WorkflowObservation = cleanvmcontract.WorkflowObservation
type RestartObservation = cleanvmcontract.RestartObservation
type UpdateQuarantineObservation = cleanvmcontract.UpdateQuarantineObservation
type UninstallObservation = cleanvmcontract.UninstallObservation
type ObservationArtifact = cleanvmcontract.ObservationArtifact
type OperationalCheck = cleanvmcontract.OperationalCheck
type Details = cleanvmcontract.Details

var requiredCheckIDs = cleanvmcontract.RequiredCheckIDs()

func RequiredCheckIDs() []string { return cleanvmcontract.RequiredCheckIDs() }

func validDigest(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

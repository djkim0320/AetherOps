package knowledge

import "context"

// RecoverCurationValidationCandidates removes only crash-left local dry-run
// generations. These candidates contain no accepted user state and no external
// operation is replayed during recovery.
func (service *Service) RecoverCurationValidationCandidates(ctx context.Context) (int64, error) {
	if err := service.configured(); err != nil {
		return 0, err
	}
	return service.DB.DeleteBuildingKnowledgeGenerationsByContract(ctx, curationValidationContractSHA256())
}

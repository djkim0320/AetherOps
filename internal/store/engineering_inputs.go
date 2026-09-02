package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

const (
	EngineeringInputArtifact = "artifact"
	EngineeringInputMaterial = "material"
)

// EngineeringInput is an immutable CAS object which the current project is
// allowed to stage into an isolated solver workspace. The caller must bind the
// expected SHA-256 in its approved solver arguments so a mutable database
// locator can never widen an already-approved execution scope.
type EngineeringInput struct {
	Source    string `json:"source"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	BlobHash  string `json:"sha256"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
}

// ListEngineeringInputs returns current-run artifacts, adopted artifacts from
// successful runs in the same project, and ready user-pinned materials. It
// never exposes another project's CAS identities.
func (db *DB) ListEngineeringInputs(ctx context.Context, projectID, runID string) ([]EngineeringInput, error) {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(runID) == "" {
		return nil, errors.New("engineering input project and run are required")
	}
	var ownedProject string
	if err := db.sql.QueryRowContext(ctx, "SELECT project_id FROM runs WHERE id=?", runID).Scan(&ownedProject); err != nil {
		return nil, err
	}
	if ownedProject != projectID {
		return nil, errors.New("engineering input run does not belong to the project")
	}
	rows, err := db.sql.QueryContext(ctx, `
SELECT 'artifact',a.id,COALESCE(NULLIF(ja.file_name,''),a.kind),a.kind,a.blob_hash,b.media_type,b.size
FROM artifacts a
JOIN runs r ON r.id=a.run_id
JOIN blobs b ON b.hash=a.blob_hash
LEFT JOIN engineering_job_artifacts ja ON ja.artifact_id=a.id
WHERE r.project_id=? AND (a.run_id=? OR (a.adopted=1 AND r.status='succeeded'))
UNION ALL
SELECT 'material',d.id,d.title,'pinned_material',d.blob_hash,b.media_type,b.size
FROM documents d JOIN blobs b ON b.hash=d.blob_hash
WHERE d.project_id=? AND d.status='ready' AND d.pinned=1
ORDER BY 1,3,2`, projectID, runID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	inputs := make([]EngineeringInput, 0)
	for rows.Next() {
		var input EngineeringInput
		if err := rows.Scan(&input.Source, &input.ID, &input.Name, &input.Kind,
			&input.BlobHash, &input.MediaType, &input.Size); err != nil {
			return nil, err
		}
		inputs = append(inputs, input)
	}
	return inputs, rows.Err()
}

// ResolveEngineeringInput verifies one exact source locator and content hash.
// Current-run artifacts are usable immediately. Older artifacts require both
// successful-run provenance and explicit adoption; pinned materials must be
// ready. These predicates are repeated at execution time after approval.
func (db *DB) ResolveEngineeringInput(
	ctx context.Context,
	projectID, runID, source, inputID, expectedSHA256 string,
) (EngineeringInput, error) {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(runID) == "" ||
		strings.TrimSpace(inputID) == "" || strings.TrimSpace(expectedSHA256) == "" {
		return EngineeringInput{}, errors.New("engineering input identity and expected hash are required")
	}
	var ownedProject string
	if err := db.sql.QueryRowContext(ctx, "SELECT project_id FROM runs WHERE id=?", runID).Scan(&ownedProject); err != nil {
		return EngineeringInput{}, err
	}
	if ownedProject != projectID {
		return EngineeringInput{}, errors.New("engineering input run does not belong to the project")
	}
	var row scanner
	switch source {
	case EngineeringInputArtifact:
		row = db.sql.QueryRowContext(ctx, `
SELECT 'artifact',a.id,COALESCE(NULLIF(ja.file_name,''),a.kind),a.kind,a.blob_hash,b.media_type,b.size
FROM artifacts a
JOIN runs r ON r.id=a.run_id
JOIN blobs b ON b.hash=a.blob_hash
LEFT JOIN engineering_job_artifacts ja ON ja.artifact_id=a.id
WHERE a.id=? AND r.project_id=? AND (a.run_id=? OR (a.adopted=1 AND r.status='succeeded'))`,
			inputID, projectID, runID)
	case EngineeringInputMaterial:
		row = db.sql.QueryRowContext(ctx, `
SELECT 'material',d.id,d.title,'pinned_material',d.blob_hash,b.media_type,b.size
FROM documents d JOIN blobs b ON b.hash=d.blob_hash
WHERE d.id=? AND d.project_id=? AND d.status='ready' AND d.pinned=1`, inputID, projectID)
	default:
		return EngineeringInput{}, errors.New("engineering input source must be artifact or material")
	}
	var input EngineeringInput
	if err := row.Scan(&input.Source, &input.ID, &input.Name, &input.Kind,
		&input.BlobHash, &input.MediaType, &input.Size); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return EngineeringInput{}, errors.New("engineering input is not owned by this project and run scope")
		}
		return EngineeringInput{}, err
	}
	if input.BlobHash != expectedSHA256 {
		return EngineeringInput{}, errors.New("engineering input hash does not match the approved content")
	}
	if input.Size <= 0 {
		return EngineeringInput{}, errors.New("engineering input is empty")
	}
	return input, nil
}

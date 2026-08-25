package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/id"
)

func (db *DB) CreateToolPackage(ctx context.Context, pkg core.ToolPackage) (core.ToolPackage, error) {
	if pkg.ID == "" {
		generated, err := id.New("tool")
		if err != nil {
			return core.ToolPackage{}, err
		}
		pkg.ID = generated
	}
	if pkg.ProjectID == "" || pkg.Name == "" || pkg.PackageSHA256 == "" || len(pkg.Files) == 0 {
		return core.ToolPackage{}, errors.New("tool package identity, hash, and files are required")
	}
	now := time.Now().UTC()
	pkg.State, pkg.RequiresRestart, pkg.CreatedAt, pkg.UpdatedAt = "pending_approval", false, now, now
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolPackage{}, err
	}
	defer tx.Rollback()
	if pkg.SourceRunID != "" {
		var projectID string
		if err := tx.QueryRowContext(ctx, `SELECT r.project_id FROM stage_attempts s JOIN runs r ON r.id=s.run_id WHERE s.id=? AND s.run_id=?`, pkg.SourceStageAttemptID, pkg.SourceRunID).Scan(&projectID); err != nil {
			return core.ToolPackage{}, err
		}
		if projectID != pkg.ProjectID {
			return core.ToolPackage{}, errors.New("tool package source stage belongs to another project")
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO tool_packages(
	 id,project_id,kind,name,display_name,description,version,state,manifest_json,package_sha256,
	 source_run_id,source_stage_attempt_id,requires_restart,error,created_at,updated_at,activated_at
	) VALUES(?,?,?,?,?,?,?,'pending_approval',?,?,?,?,0,'',?,?,NULL)`,
		pkg.ID, pkg.ProjectID, pkg.Kind, pkg.Name, pkg.DisplayName, pkg.Description, pkg.Version, pkg.ManifestJSON, pkg.PackageSHA256,
		nullString(pkg.SourceRunID), nullString(pkg.SourceStageAttemptID), formatTime(now), formatTime(now))
	if err != nil {
		return core.ToolPackage{}, err
	}
	for _, file := range pkg.Files {
		if _, err := tx.ExecContext(ctx, `INSERT INTO tool_package_files(package_id,path,content,content_sha256,size) VALUES(?,?,?,?,?)`, pkg.ID, file.Path, []byte(file.Content), file.ContentSHA256, file.Size); err != nil {
			return core.ToolPackage{}, err
		}
	}
	if pkg.SourceRunID != "" {
		if err := appendEvent(ctx, tx, pkg.SourceRunID, "tool.package_proposed", map[string]any{"package_id": pkg.ID, "kind": pkg.Kind, "name": pkg.Name, "version": pkg.Version, "package_sha256": pkg.PackageSHA256}, now); err != nil {
			return core.ToolPackage{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return core.ToolPackage{}, err
	}
	return pkg, nil
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (db *DB) ListToolPackages(ctx context.Context, projectID string) ([]core.ToolPackage, error) {
	rows, err := db.sql.QueryContext(ctx, toolPackageSelect+` WHERE project_id=? ORDER BY created_at DESC,id DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var packages []core.ToolPackage
	for rows.Next() {
		pkg, err := scanToolPackage(rows)
		if err != nil {
			return nil, err
		}
		packages = append(packages, pkg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range packages {
		if err := db.attachLatestToolInstallation(ctx, &packages[index]); err != nil {
			return nil, err
		}
	}
	return packages, nil
}

func (db *DB) ActiveToolPackages(ctx context.Context, kind string) ([]core.ToolPackage, error) {
	rows, err := db.sql.QueryContext(ctx, toolPackageSelect+` WHERE state='active' AND (?='' OR kind=?) ORDER BY project_id,name`, kind, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var packages []core.ToolPackage
	for rows.Next() {
		pkg, err := scanToolPackage(rows)
		if err != nil {
			return nil, err
		}
		packages = append(packages, pkg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range packages {
		if err := db.attachLatestToolInstallation(ctx, &packages[index]); err != nil {
			return nil, err
		}
	}
	return packages, nil
}

func (db *DB) ToolPackage(ctx context.Context, projectID, packageID string, includeFiles bool) (core.ToolPackage, error) {
	pkg, err := scanToolPackage(db.sql.QueryRowContext(ctx, toolPackageSelect+` WHERE id=? AND project_id=?`, packageID, projectID))
	if err != nil {
		return core.ToolPackage{}, err
	}
	if includeFiles {
		pkg.Files, err = db.toolPackageFiles(ctx, packageID)
		if err != nil {
			return core.ToolPackage{}, err
		}
	}
	if err := db.attachLatestToolInstallation(ctx, &pkg); err != nil {
		return core.ToolPackage{}, err
	}
	return pkg, nil
}

func (db *DB) ActiveToolPackageByID(ctx context.Context, packageID string) (core.ToolPackage, error) {
	pkg, err := scanToolPackage(db.sql.QueryRowContext(ctx, toolPackageSelect+` WHERE id=? AND state='active'`, packageID))
	if err != nil {
		return core.ToolPackage{}, err
	}
	pkg.Files, err = db.toolPackageFiles(ctx, packageID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if err := db.attachLatestToolInstallation(ctx, &pkg); err != nil {
		return core.ToolPackage{}, err
	}
	return pkg, nil
}

func (db *DB) attachLatestToolInstallation(ctx context.Context, pkg *core.ToolPackage) error {
	installation, err := scanToolInstallation(db.sql.QueryRowContext(ctx, toolInstallationSelect+`
WHERE package_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, pkg.ID))
	if errors.Is(err, sql.ErrNoRows) {
		pkg.Installation = nil
		return nil
	}
	if err != nil {
		return err
	}
	pkg.Installation = &installation
	return nil
}

func (db *DB) toolPackageFiles(ctx context.Context, packageID string) ([]core.ToolPackageFile, error) {
	rows, err := db.sql.QueryContext(ctx, `SELECT path,content,content_sha256,size FROM tool_package_files WHERE package_id=? ORDER BY path`, packageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []core.ToolPackageFile
	for rows.Next() {
		var f core.ToolPackageFile
		var content []byte
		if err := rows.Scan(&f.Path, &content, &f.ContentSHA256, &f.Size); err != nil {
			return nil, err
		}
		f.Content = string(content)
		files = append(files, f)
	}
	return files, rows.Err()
}

func (db *DB) ActivateToolPackage(ctx context.Context, projectID, packageID string) (core.ToolPackage, error) {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolPackage{}, err
	}
	defer tx.Rollback()
	pkg, err := scanToolPackage(tx.QueryRowContext(ctx, toolPackageSelect+` WHERE id=? AND project_id=?`, packageID, projectID))
	if err != nil {
		return core.ToolPackage{}, err
	}
	if pkg.State != "pending_approval" && pkg.State != "disabled" && pkg.State != "failed" {
		return core.ToolPackage{}, errors.New("tool package is not awaiting activation")
	}
	now := time.Now().UTC()
	if _, err = tx.ExecContext(ctx, `UPDATE tool_packages SET state='disabled',requires_restart=0,updated_at=? WHERE project_id=? AND name=? AND state='active'`, formatTime(now), projectID, pkg.Name); err != nil {
		return core.ToolPackage{}, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE tool_packages SET state='active',requires_restart=0,error='',updated_at=?,activated_at=? WHERE id=? AND project_id=? AND state IN ('pending_approval','disabled','failed')`, formatTime(now), formatTime(now), packageID, projectID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return core.ToolPackage{}, errors.New("tool package activation lost concurrency race")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO tool_activation_events(package_id,project_id,action,package_sha256,detail,created_at) VALUES(?,?,'approved',?,'user approved activation',?)`, packageID, projectID, pkg.PackageSHA256, formatTime(now)); err != nil {
		return core.ToolPackage{}, err
	}
	if err = tx.Commit(); err != nil {
		return core.ToolPackage{}, err
	}
	return db.ToolPackage(ctx, projectID, packageID, false)
}

func (db *DB) DisableToolPackage(ctx context.Context, projectID, packageID string) (core.ToolPackage, error) {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return core.ToolPackage{}, err
	}
	defer tx.Rollback()
	pkg, err := scanToolPackage(tx.QueryRowContext(ctx, toolPackageSelect+` WHERE id=? AND project_id=?`, packageID, projectID))
	if err != nil {
		return core.ToolPackage{}, err
	}
	if pkg.State != "active" {
		return core.ToolPackage{}, errors.New("only an active tool package can be disabled")
	}
	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, `UPDATE tool_packages SET state='disabled',requires_restart=0,updated_at=? WHERE id=? AND state='active'`, formatTime(now), packageID)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return core.ToolPackage{}, errors.New("tool package disable lost concurrency race")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO tool_activation_events(package_id,project_id,action,package_sha256,detail,created_at) VALUES(?,?,'disabled',?,'user disabled package',?)`, packageID, projectID, pkg.PackageSHA256, formatTime(now)); err != nil {
		return core.ToolPackage{}, err
	}
	if err = tx.Commit(); err != nil {
		return core.ToolPackage{}, err
	}
	return db.ToolPackage(ctx, projectID, packageID, false)
}

const toolPackageSelect = `SELECT id,project_id,kind,name,display_name,description,version,state,manifest_json,package_sha256,
 COALESCE(source_run_id,''),COALESCE(source_stage_attempt_id,''),requires_restart,error,created_at,updated_at,activated_at FROM tool_packages`

func scanToolPackage(row scanner) (core.ToolPackage, error) {
	var pkg core.ToolPackage
	var restart int
	var created, updated string
	var activated sql.NullString
	err := row.Scan(&pkg.ID, &pkg.ProjectID, &pkg.Kind, &pkg.Name, &pkg.DisplayName, &pkg.Description, &pkg.Version, &pkg.State, &pkg.ManifestJSON, &pkg.PackageSHA256, &pkg.SourceRunID, &pkg.SourceStageAttemptID, &restart, &pkg.Error, &created, &updated, &activated)
	if err != nil {
		return core.ToolPackage{}, err
	}
	pkg.RequiresRestart = restart != 0
	pkg.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.ToolPackage{}, err
	}
	pkg.UpdatedAt, err = parseTime(updated)
	if err != nil {
		return core.ToolPackage{}, err
	}
	if activated.Valid {
		value, e := parseTime(activated.String)
		if e != nil {
			return core.ToolPackage{}, e
		}
		pkg.ActivatedAt = &value
	}
	return pkg, nil
}

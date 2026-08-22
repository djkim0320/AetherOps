package store

import (
	"context"
	"errors"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/id"
)

type Download struct {
	ID        string    `json:"id"`
	FileName  string    `json:"file_name"`
	BlobHash  string    `json:"blob_hash"`
	Size      int64     `json:"size"`
	MediaType string    `json:"media_type"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

func (db *DB) RecordDownload(ctx context.Context, fileName, mediaType string, receipt cas.Receipt) (Download, error) {
	if fileName == "" || mediaType == "" || receipt.Hash == "" || receipt.Size < 0 {
		return Download{}, errors.New("download file, media type, and CAS receipt are required")
	}
	if err := db.RegisterBlob(ctx, receipt, mediaType); err != nil {
		return Download{}, err
	}
	downloadID, err := id.New("dwn")
	if err != nil {
		return Download{}, err
	}
	now := time.Now().UTC()
	result, err := db.sql.ExecContext(ctx, `
INSERT INTO downloads(id, file_name, blob_hash, size, media_type, status, created_at)
VALUES(?, ?, ?, ?, ?, 'quarantined', ?)
ON CONFLICT(file_name, blob_hash) DO NOTHING`, downloadID, fileName, receipt.Hash,
		receipt.Size, mediaType, formatTime(now))
	if err != nil {
		return Download{}, err
	}
	if count, err := result.RowsAffected(); err != nil {
		return Download{}, err
	} else if count == 0 {
		return db.downloadByIdentity(ctx, fileName, receipt.Hash)
	}
	return Download{ID: downloadID, FileName: fileName, BlobHash: receipt.Hash,
		Size: receipt.Size, MediaType: mediaType, Status: "quarantined", CreatedAt: now}, nil
}

func (db *DB) downloadByIdentity(ctx context.Context, fileName, blobHash string) (Download, error) {
	var item Download
	var created string
	err := db.sql.QueryRowContext(ctx, `
SELECT id, file_name, blob_hash, size, media_type, status, created_at
FROM downloads WHERE file_name = ? AND blob_hash = ?`, fileName, blobHash).Scan(
		&item.ID, &item.FileName, &item.BlobHash, &item.Size, &item.MediaType, &item.Status, &created)
	if err != nil {
		return Download{}, err
	}
	item.CreatedAt, err = parseTime(created)
	return item, err
}

package download

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type fileState struct {
	size    int64
	updated time.Time
	stable  bool
}

// Watcher records complete browser downloads in CAS and the SQLite ledger. It
// never opens or executes a downloaded file.
type Watcher struct {
	Directory string
	DB        *store.DB
	CAS       *cas.Store
	Interval  time.Duration
}

func (watcher *Watcher) Run(ctx context.Context) error {
	if watcher.DB == nil || watcher.CAS == nil || strings.TrimSpace(watcher.Directory) == "" {
		return errors.New("download watcher is not configured")
	}
	if err := os.MkdirAll(watcher.Directory, 0o700); err != nil {
		return err
	}
	interval := watcher.Interval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	states := make(map[string]fileState)
	for {
		if err := watcher.scan(ctx, states); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (watcher *Watcher) scan(ctx context.Context, states map[string]fileState) error {
	entries, err := os.ReadDir(watcher.Directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(strings.ToLower(entry.Name()), ".crdownload") {
			continue
		}
		path := filepath.Join(watcher.Directory, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return err
		}
		prior, observed := states[path]
		current := fileState{size: info.Size(), updated: info.ModTime()}
		if !observed || prior.size != current.size || !prior.updated.Equal(current.updated) {
			states[path] = current
			continue
		}
		if prior.stable {
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		receipt, putErr := watcher.CAS.PutReader(file)
		closeErr := file.Close()
		if err := errors.Join(putErr, closeErr); err != nil {
			return fmt.Errorf("hash quarantined download %s: %w", entry.Name(), err)
		}
		if _, err := watcher.CAS.ReadVerified(receipt.Hash); err != nil {
			return err
		}
		mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(entry.Name())))
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		if _, err := watcher.DB.RecordDownload(ctx, entry.Name(), mediaType, receipt); err != nil {
			return err
		}
		current.stable = true
		states[path] = current
	}
	return nil
}

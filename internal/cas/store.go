package cas

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
)

var (
	validHash   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	validPrefix = regexp.MustCompile(`^[a-f0-9]{2}$`)
)

type Store struct {
	root     string
	readOnly bool
}

type Receipt struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
	Path string `json:"path"`
}

type ReconcileResult struct {
	OrphanedObjectsRemoved int `json:"orphaned_objects_removed"`
	TemporaryFilesRemoved  int `json:"temporary_files_removed"`
}

func Open(root string) (*Store, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(absolute, "sha256"), 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(absolute, "tmp"), 0o700); err != nil {
		return nil, err
	}
	return &Store{root: absolute}, nil
}

// OpenReadOnly opens an existing CAS without creating directories. Mutation
// methods fail closed, allowing release verification to prove that reading
// evidence cannot alter the product's durable state.
func OpenReadOnly(root string) (*Store, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	for _, directory := range []string{absolute, filepath.Join(absolute, "sha256")} {
		info, err := os.Lstat(directory)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("read-only CAS path is not a regular directory: %s", directory)
		}
	}
	return &Store{root: absolute, readOnly: true}, nil
}

func (store *Store) Root() string {
	return store.root
}

func (store *Store) PutBytes(data []byte) (Receipt, error) {
	return store.PutReader(bytes.NewReader(data))
}

func (store *Store) PutReader(reader io.Reader) (Receipt, error) {
	if store.readOnly {
		return Receipt{}, errors.New("CAS is read-only")
	}
	temp, err := os.CreateTemp(filepath.Join(store.root, "tmp"), "blob-*")
	if err != nil {
		return Receipt{}, err
	}
	tempName := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempName)
		}
	}()

	hasher := sha256.New()
	size, err := io.Copy(io.MultiWriter(temp, hasher), reader)
	if err != nil {
		return Receipt{}, err
	}
	if err := temp.Sync(); err != nil {
		return Receipt{}, err
	}
	if err := temp.Close(); err != nil {
		return Receipt{}, err
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	dir := filepath.Join(store.root, "sha256", hash[:2])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Receipt{}, err
	}
	target := filepath.Join(dir, hash)

	if info, statErr := os.Stat(target); statErr == nil {
		if info.Size() != size {
			return Receipt{}, fmt.Errorf("CAS collision for %s", hash)
		}
		if err := os.Remove(tempName); err != nil {
			return Receipt{}, err
		}
		committed = true
		return Receipt{Hash: hash, Size: size, Path: target}, nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Receipt{}, statErr
	}

	if err := durableMove(tempName, target); err != nil {
		return Receipt{}, err
	}
	committed = true
	return Receipt{Hash: hash, Size: size, Path: target}, nil
}

func (store *Store) Path(hash string) (string, error) {
	if !validHash.MatchString(hash) {
		return "", errors.New("invalid SHA-256 hash")
	}
	path := filepath.Join(store.root, "sha256", hash[:2], hash)
	if info, err := os.Stat(path); err != nil {
		return "", err
	} else if !info.Mode().IsRegular() {
		return "", errors.New("CAS object is not a regular file")
	}
	return path, nil
}

func (store *Store) ReadVerified(hash string) ([]byte, error) {
	path, err := store.Path(hash)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	hasher := sha256.New()
	data, err := io.ReadAll(io.TeeReader(file, hasher))
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(hasher.Sum(nil)) != hash {
		return nil, errors.New("CAS readback hash mismatch")
	}
	return data, nil
}

// Delete removes one explicitly addressed CAS object. Callers must first remove
// every database reference and prove the object is orphaned.
func (store *Store) Delete(hash string) error {
	if store.readOnly {
		return errors.New("CAS is read-only")
	}
	path, err := store.Path(hash)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return os.Remove(path)
}

// Reconcile removes CAS files which have no authoritative SQLite blob row and
// abandoned temporary files. It must run only during primary application
// startup, before any component is allowed to write to the CAS. Unexpected
// directory entries fail closed instead of being deleted.
func (store *Store) Reconcile(ctx context.Context, registered map[string]struct{}) (ReconcileResult, error) {
	if store.readOnly {
		return ReconcileResult{}, errors.New("CAS is read-only")
	}
	for hash := range registered {
		if !validHash.MatchString(hash) {
			return ReconcileResult{}, fmt.Errorf("registered CAS hash is invalid: %q", hash)
		}
	}
	type candidate struct {
		path      string
		temporary bool
	}
	var candidates []candidate
	shaRoot := filepath.Join(store.root, "sha256")
	prefixes, err := os.ReadDir(shaRoot)
	if err != nil {
		return ReconcileResult{}, fmt.Errorf("enumerate CAS prefixes: %w", err)
	}
	for _, prefix := range prefixes {
		if err := ctx.Err(); err != nil {
			return ReconcileResult{}, err
		}
		prefixInfo, err := prefix.Info()
		if err != nil {
			return ReconcileResult{}, fmt.Errorf("inspect CAS prefix %q: %w", prefix.Name(), err)
		}
		if !validPrefix.MatchString(prefix.Name()) ||
			!prefixInfo.IsDir() || prefixInfo.Mode()&os.ModeSymlink != 0 {
			return ReconcileResult{}, fmt.Errorf("unexpected CAS prefix entry %q", prefix.Name())
		}
		files, err := os.ReadDir(filepath.Join(shaRoot, prefix.Name()))
		if err != nil {
			return ReconcileResult{}, fmt.Errorf("enumerate CAS prefix %q: %w", prefix.Name(), err)
		}
		for _, entry := range files {
			info, err := entry.Info()
			if err != nil {
				return ReconcileResult{}, fmt.Errorf("inspect CAS object %q: %w", entry.Name(), err)
			}
			if !validHash.MatchString(entry.Name()) || entry.Name()[:2] != prefix.Name() ||
				!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return ReconcileResult{}, fmt.Errorf("unexpected CAS object entry %q", entry.Name())
			}
			if _, ok := registered[entry.Name()]; !ok {
				candidates = append(candidates, candidate{path: filepath.Join(shaRoot, prefix.Name(), entry.Name())})
			}
		}
	}
	temporaryRoot := filepath.Join(store.root, "tmp")
	temporaryFiles, err := os.ReadDir(temporaryRoot)
	if err != nil {
		return ReconcileResult{}, fmt.Errorf("enumerate CAS temporary files: %w", err)
	}
	for _, entry := range temporaryFiles {
		info, err := entry.Info()
		if err != nil {
			return ReconcileResult{}, fmt.Errorf("inspect CAS temporary file %q: %w", entry.Name(), err)
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return ReconcileResult{}, fmt.Errorf("unexpected CAS temporary entry %q", entry.Name())
		}
		candidates = append(candidates, candidate{path: filepath.Join(temporaryRoot, entry.Name()), temporary: true})
	}
	if len(candidates) == 0 {
		return ReconcileResult{}, nil
	}

	workerCount := runtime.NumCPU()
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > 16 {
		workerCount = 16
	}
	if workerCount > len(candidates) {
		workerCount = len(candidates)
	}
	jobs := make(chan candidate)
	type outcome struct {
		candidate candidate
		err       error
	}
	outcomes := make(chan outcome, len(candidates))
	var workers sync.WaitGroup
	for index := 0; index < workerCount; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for item := range jobs {
				if err := ctx.Err(); err != nil {
					outcomes <- outcome{candidate: item, err: err}
					continue
				}
				err := os.Remove(item.path)
				if errors.Is(err, os.ErrNotExist) {
					err = nil
				}
				outcomes <- outcome{candidate: item, err: err}
			}
		}()
	}
	for _, item := range candidates {
		jobs <- item
	}
	close(jobs)
	workers.Wait()
	close(outcomes)

	var result ReconcileResult
	var reconcileErr error
	for outcome := range outcomes {
		if outcome.err != nil {
			reconcileErr = errors.Join(reconcileErr, fmt.Errorf("remove stale CAS file %q: %w", outcome.candidate.path, outcome.err))
			continue
		}
		if outcome.candidate.temporary {
			result.TemporaryFilesRemoved++
		} else {
			result.OrphanedObjectsRemoved++
		}
	}
	return result, reconcileErr
}

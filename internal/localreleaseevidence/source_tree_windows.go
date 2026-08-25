//go:build windows

package localreleaseevidence

import "github.com/djkim0320/AetherOps/internal/releasetree"

const maximumSourceFileBytes = releasetree.MaxFileBytes

type sourceTreeSeal = releasetree.Seal

var (
	sourceRootFiles       = releasetree.RootFiles()
	sourceRootDirectories = releasetree.RootDirectories()
)

func sealSourceTree(sourceRoot string) (sourceTreeSeal, error) {
	return releasetree.Compute(sourceRoot)
}

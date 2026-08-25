//go:build windows && amd64

package desktop

// The generated COFF resource is checked in so normal builds stay offline and
// deterministic. Re-run this command only when assets/icons/aetherops.ico is
// intentionally replaced.
//go:generate go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -ico ../../assets/icons/aetherops.ico -o rsrc_windows_amd64.syso

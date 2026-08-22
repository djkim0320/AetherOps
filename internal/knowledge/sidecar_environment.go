package knowledge

import (
	"errors"
	"path/filepath"
	"sort"
	"strings"
)

var sidecarEnvironmentAllowlist = map[string]struct{}{
	"APPDATA": {}, "COMSPEC": {}, "LOCALAPPDATA": {}, "PROGRAMDATA": {},
	"SYSTEMDRIVE": {}, "SYSTEMROOT": {}, "TEMP": {}, "TMP": {},
	"USERPROFILE": {}, "WINDIR": {},
}

// IsolatedSidecarEnvironment creates the complete environment for the fixed
// Node/Oxigraph worker. Node injection knobs, PATH/NODE_PATH, proxy settings,
// npm configuration, credentials, and every unrelated parent value are
// deliberately omitted. Exactly one verified absolute module path is required.
func IsolatedSidecarEnvironment(parent []string) ([]string, error) {
	values := make(map[string]string, len(sidecarEnvironmentAllowlist)+1)
	moduleCount := 0
	for _, item := range parent {
		name, value, ok := strings.Cut(item, "=")
		name = strings.ToUpper(strings.TrimSpace(name))
		if !ok || name == "" || strings.ContainsAny(value, "\x00\r\n") {
			continue
		}
		if name == "AETHEROPS_OXIGRAPH_MODULE" {
			moduleCount++
			if moduleCount > 1 {
				return nil, errors.New("Oxigraph sidecar environment duplicates its module binding")
			}
			if strings.TrimSpace(value) != value || !filepath.IsAbs(value) || filepath.Clean(value) != value {
				return nil, errors.New("Oxigraph sidecar module binding must be one canonical absolute path")
			}
			values[name] = value
			continue
		}
		if _, allowed := sidecarEnvironmentAllowlist[name]; allowed {
			if _, duplicate := values[name]; duplicate {
				return nil, errors.New("Oxigraph sidecar environment duplicates an allowed system value")
			}
			values[name] = value
		}
	}
	if moduleCount != 1 {
		return nil, errors.New("Oxigraph sidecar environment requires one module binding")
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+values[name])
	}
	return result, nil
}

package knowledge

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestIsolatedSidecarEnvironmentDropsNodeInjectionAndSecrets(t *testing.T) {
	module := filepath.Join(t.TempDir(), "oxigraph")
	environment, err := IsolatedSidecarEnvironment([]string{
		`SystemRoot=C:\Windows`, `TEMP=C:\Temp`,
		`NODE_OPTIONS=--require=C:\attacker.js`, `NODE_PATH=C:\attacker`,
		`NPM_CONFIG_USERCONFIG=C:\attacker.npmrc`, `PATH=C:\attacker`,
		`OPENAI_API_KEY=must-not-cross-process`, "AETHEROPS_OXIGRAPH_MODULE=" + module,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(environment, "\n")
	for _, forbidden := range []string{"NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG", "PATH=", "OPENAI_API_KEY", "attacker"} {
		if strings.Contains(strings.ToUpper(joined), forbidden) {
			t.Fatalf("isolated environment retained %q: %s", forbidden, joined)
		}
	}
	if !strings.Contains(joined, "AETHEROPS_OXIGRAPH_MODULE="+module) || !strings.Contains(strings.ToUpper(joined), `SYSTEMROOT=C:\WINDOWS`) {
		t.Fatalf("isolated environment omitted its fixed module/system contract: %s", joined)
	}
}

func TestIsolatedSidecarEnvironmentRejectsDuplicateModuleBinding(t *testing.T) {
	module := filepath.Join(t.TempDir(), "oxigraph")
	if _, err := IsolatedSidecarEnvironment([]string{
		"AETHEROPS_OXIGRAPH_MODULE=" + module,
		"aetherops_oxigraph_module=" + module,
	}); err == nil {
		t.Fatal("duplicate case-insensitive Oxigraph module binding was accepted")
	}
}

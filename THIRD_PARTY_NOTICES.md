# Third-party notices

AetherOps is private first-party software. This notice does not grant a license to the AetherOps source code, and the distribution intentionally contains no AetherOps `LICENSE` file. Third-party works remain under their own terms.

Exact acquisition URLs, SHA-256 receipts, source-tree pins, and file sizes are recorded in `runtime/source-acquisition.json`. Complete license texts are under `runtime/licenses`, and the corresponding source archives distributed with the package are under `runtime/sources`.

## Managed AI and browser runtimes

- **Node.js 24.19.0** — Node.js license and the notices shipped inside its verified runtime tree.
- **Codex CLI 0.146.1** — Apache-2.0 and the notices shipped in the npm package.
- **Chrome DevTools MCP 1.6.0** — Apache-2.0 and the notices shipped in the npm package.
- **Oxigraph JavaScript 0.5.9** — the Node/WASM engine used by the non-persistent, read-only knowledge-query sidecar, dual-licensed under MIT or Apache-2.0. The npm package and its metadata are retained in the verified managed runtime tree. Upstream source: `https://github.com/oxigraph/oxigraph/tree/main/js`.
- **Microsoft Edge WebView2 Runtime** — Microsoft license terms. The Evergreen runtime is an external system prerequisite and is not copied into this package.

The Go 1.26.5 toolchain is build-only and is not part of the application package.

## Engineering and aerodynamic tools

### OpenVSP / VSPAERO 3.50.4

OpenVSP is redistributed unmodified under the NASA Open Source Agreement 1.3 (NOSA 1.3). The verified upstream Windows archive is retained as an independent runtime tree, including its original notices. The exact OpenVSP source snapshot for tag `OpenVSP_3.50.4` (commit `e10ca9651d9fa349f08f0fdbe26ef805080e1aec`) accompanies the binaries.

NOSA requires preservation of notices and availability of the corresponding source for binary redistribution. NASA and contributors do not endorse AetherOps. See `runtime/licenses/openvsp/3.50.4/LICENSE.txt` and `runtime/sources/openvsp/3.50.4/`.

### Gmsh 4.14.1

Gmsh is redistributed unmodified under GPL-2.0-or-later with the exceptions stated in its license for named third-party libraries. AetherOps invokes `gmsh.exe` as a separate process and exchanges files; it does not link the Gmsh SDK or DLL into the proprietary core.

See `runtime/licenses/gmsh/4.14.1/LICENSE.txt` and the complete upstream source archive in `runtime/sources/gmsh/4.14.1/`. Gmsh also offers separate commercial licensing; this distribution relies only on the included GPL terms for the independent executable.

### XFOIL 6.99

XFOIL is redistributed under GPL-2.0-only. The official Windows executable is 32-bit x86 and runs as an independent child process on Windows 11 x64; it is not represented as a native x64 binary. The official 6.99 source archive and GPL text accompany it.

See `runtime/licenses/xfoil/6.99/GPL-2.0.txt` and `runtime/sources/xfoil/6.99/`.

### SU2 8.5.0 win64-omp

SU2 is redistributed unmodified under LGPL-2.1-only as an independent command-line process. This package contains the official Windows x64 OpenMP asset and deliberately excludes the MPI asset. The official release was built with MPI disabled, so its restricted ParMETIS path is not included. The binary targets Haswell-class CPU features; AetherOps must reject incompatible CPUs rather than substitute another solver.

SU2's `LICENSE.md` contains additional notices and terms for bundled code, including CGNS/HDF5, TecIO, CLI11, and other dependencies. The exact Tecplot copyright and license notice must remain intact. AetherOps does not modify TecIO. See `runtime/licenses/su2/8.5.0/`.

The corresponding source package pins SU2 commit `12eb826f049ef7f67df974dfcb44cf36ee07c0f8`, all direct SU2 submodules, and the direct CoolProp submodules used by that source tree. Their archive-to-source-path mapping and hashes are in `runtime/source-acquisition.json`; the archives are in `runtime/sources/su2/8.5.0/`.

## First-party library dependencies

The reviewed, hash-pinned license and source receipt contract is `sbom/license-manifest.json`. Checked-in license payloads are distributed under `sbom/licenses/`; managed-runtime license payloads remain in their verified runtime trees. The CycloneDX 1.5 and SPDX 2.3 inventories in `sbom/` enumerate only actual production dependencies as required components and classify frontend build dependencies as excluded from the release.

The production Go module closure linked into `aetherops.exe` is:

- github.com/razvandimescu/gopdf v0.10.0 — MIT
- github.com/robfig/cron/v3 v3.0.1 — MIT
- github.com/wailsapp/go-webview2 v1.0.23 — MIT
- golang.org/x/sys v0.47.0 — BSD-3-Clause
- modernc.org/sqlite v1.56.0 — BSD-3-Clause
- github.com/dustin/go-humanize v1.0.1 — MIT
- github.com/mattn/go-isatty v0.0.24 — MIT
- github.com/ncruces/go-strftime v1.0.0 — MIT
- github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec — BSD-3-Clause
- modernc.org/libc v1.74.4 — BSD-3-Clause
- modernc.org/mathutil v1.7.1 — BSD-3-Clause
- modernc.org/memory v1.11.0 — BSD-3-Clause

Frontend production code includes **Preact 10.26.4** and **Cytoscape.js 3.34.0**, both under MIT. The Oxigraph sidecar runtime is listed above with its selected Apache-2.0 payload under the upstream `MIT OR Apache-2.0` expression.

The 138 packages reachable only from frontend `devDependencies` are build/test inputs, are recorded as `distributed=false`, and are not represented as production dependencies. The 21 Go modules outside `go list -deps ./cmd/aetherops` are likewise non-production module-graph inputs. The Go 1.26.5 toolchain remains build-only and is not distributed.

- **Cytoscape.js 3.34.0** — distributed in the frontend bundle from the npm package `cytoscape` under the MIT license. Upstream source: `https://github.com/cytoscape/cytoscape.js`.

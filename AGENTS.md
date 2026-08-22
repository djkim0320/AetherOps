# AetherOps engineering rules

## Product boundaries

- Build only the new AetherOps core in this repository. Do not import or inspect legacy AetherOps source or data.
- Keep the first-party core small and auditable. External runtimes may be large when they provide a required capability.
- Codex App Server owns authentication, conversations, model execution, and external MCP. AetherOps owns research orchestration, persistence, memory, scheduling, browser supervision, and artifacts.
- Do not add provider fallbacks, a plugin marketplace, event sourcing, a second general agent runtime, or silent degraded modes.

## Safety invariants

- Bind application HTTP endpoints to loopback only and authenticate every mutating request.
- The internet WebView2 environment must never receive native host objects or shell web-message bridges.
- Browser actions are autonomous; arbitrary commands, file writes, and write-type external MCP tools require approval.
- When an existing tool cannot satisfy a research step, use `tool_package_propose` only for a bounded reusable Skill or declarative HTTPS JSON MCP adapter. Never claim it is active until the user reviews it in Tool Studio and `tool_catalog` confirms it. Read Skills with `tool_get`; invoke adapters with `tool_run`.
- Never automatically replay an interrupted Codex turn, browser mutation, form submission, or external write.
- Secrets belong in Windows Credential Manager or Codex's dedicated credential store, never in SQLite, logs, prompts, or tracked files.
- Large bytes enter the content-addressed store only after durable write and SHA-256 verification.

## Build and verification

- Use `tools\dev.ps1 bootstrap` to install pinned project-local build tools.
- Use `tools\dev.ps1 test` for Go tests, frontend checks, and dependency-boundary checks.
- Use `tools\dev.ps1 build` for the Windows x64 executable.
- Keep `build` as a clean runnable layout: `aetherops.exe`, `runtime-manifest.json`, `runtime`, `knowledge-sidecar`, and optional local `data` only.
- Do not create `aetherops-vN.exe`, `fixed`, `retest`, timestamped executables, session descriptors, tokens, logs, or release evidence in `build`.
- Put transient launch/evaluation sessions in a unique directory under the Windows temporary directory and remove that directory when the session ends. Stop the exact running process before replacing `build\aetherops.exe`.
- Prefer real SQLite, HTTP, MCP, and WebView2 integration tests. Protocol fixtures may reproduce failures but must not be used to claim a successful release path.
- CPU-bound work must use bounded worker pools derived from `runtime.NumCPU()`.

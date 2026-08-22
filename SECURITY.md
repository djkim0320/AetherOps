# Security policy

## Trust boundaries

- The local shell is trusted application UI.
- Internet content and downloaded bytes are untrusted.
- Codex App Server and configured MCP servers are supervised external runtimes.
- A process already running as the same Windows user is outside the v1 threat model.
- Runtime updates require an HTTPS stable feed signed by the product-pinned
  Ed25519 trust root. Each retained artifact has a separate signed attestation
  over its digest, npm SRI, archive policy, entrypoint, and size bounds.

## Invariants

- The server listens only on an operating-system-selected loopback port.
- The shell and internet browser use separate WebView2 environments and profiles.
- Shell pages are never exposed through the internet browser's DevTools endpoint.
- Internet pages receive no native bridge or host object.
- Private, loopback, link-local, metadata, file, and custom-scheme navigation is blocked unless an origin is explicitly configured.
- Downloads are quarantined, hashed, and never executed automatically.
- Interrupted external mutations are marked uncertain and are never replayed automatically.
- Unknown MCP tools are treated as mutating and require approval.
- Agent-authored extensions are never activated by the agent that proposed them. Tool Studio requires explicit user approval of the immutable package hash. Skills and declarative MCP adapters become available immediately through the project-authorized internal MCP and are never installed into a global tool directory.
- Managed MCP packages are declarative public-HTTPS JSON adapters interpreted by AetherOps. Arbitrary package code, shell commands, dependency installation, TCP listeners, local/private addresses, and cross-project stage capabilities are rejected.
- Uninstall preserves the SQLite database, CAS, dedicated Codex home, downloads,
  and both WebView2 profiles by default. Browser-profile or full-v2-data deletion
  requires an explicit default-No interactive choice or an exact documented
  silent switch, and every recursive target is checked against its fixed
  `%LOCALAPPDATA%\AetherOps\v2` path before removal.

## Secret handling

ChatGPT credentials remain in the dedicated Codex credential store. The OpenAI Platform key is stored in Windows Credential Manager. Reports, logs, SQLite, and CAS content must not contain either credential.

## Reporting

This repository is private. Report vulnerabilities directly to the repository owner and do not open public disclosures.

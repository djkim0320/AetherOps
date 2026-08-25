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
- Browser downloads are quarantined, hashed, and never executed automatically. A Tool Studio portable payload is a separate explicit exception: exact URL, size, SHA-256, adapter, publisher/license, and same-user native-code permissions must be approved before download and probe.
- Interrupted external mutations are marked uncertain and are never replayed automatically.
- Unknown MCP tools are treated as mutating and require approval.
- Agent-authored extensions are never silently activated by the agent that proposed them. Portable installation is released only by the normal user approval surface or the Tool Studio review action; the grant is bound to the immutable package/payload/adapter identity and, for live research, one exact run and stage.
- Managed MCP packages are interpreted by AetherOps. V1 packages are declarative public-HTTPS JSON adapters. V2 may reference one official portable EXE/ZIP, but arbitrary adapter code, shell command lines, installer/package-manager execution, TCP listeners, local/private download addresses, and cross-project capabilities are rejected. Install and invocation journals prevent replay; a running native invocation found after restart becomes uncertain.
- A Windows Job Object is a lifetime boundary, not a security sandbox. Until an AppContainer launcher is implemented, approved portable native code runs with the current Windows user's OS-level filesystem and network permissions. The approval UI must state this and must not describe the scratch directory as OS isolation.
- Uninstall preserves the SQLite database, CAS, dedicated Codex home, downloads,
  and both WebView2 profiles by default. Browser-profile or full-v2-data deletion
  requires an explicit default-No interactive choice or an exact documented
  silent switch, and every recursive target is checked against its fixed
  `%LOCALAPPDATA%\AetherOps\v2` path before removal.

## Secret handling

ChatGPT credentials remain in the dedicated Codex credential store. The OpenAI Platform key is stored in Windows Credential Manager. Reports, logs, SQLite, and CAS content must not contain either credential.

## Reporting

This repository is private. Report vulnerabilities directly to the repository owner and do not open public disclosures.

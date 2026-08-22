# Production signed-feed evidence

`cmd/productionfeedevidence` is the sole trusted producer for the external
`production_update_feed` release gate. It is intentionally not a feed builder
or signing tool. The private signing key never enters this process.

The producer requires all of the following real inputs:

- the exact current prepared release ledger and exact sibling candidate files;
- a JSON trust file containing the production stable HTTPS URL, Ed25519 key id,
  and public key;
- a currently reachable internet WebView2 CDP endpoint;
- the dedicated AetherOps `CODEX_HOME` directory;
- a Windows 11 x64 host with public DNS and system-trusted TLS connectivity.

Example trust file (public verification material only):

```json
{
  "schema": "aetherops_production_feed_trust_v1",
  "feed_url": "https://updates.example.com/aetherops/stable.json",
  "key_id": "aetherops-runtime-2026",
  "public_key_base64": "<Ed25519 public key>"
}
```

Example invocation:

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\productionfeedevidence `
  -prepared-ledger .\build\release-ledger-r7.json `
  -aetherops-exe .\build\aetherops.exe `
  -trust-config C:\release-secrets\aetherops-feed-public.json `
  -browser-endpoint http://127.0.0.1:9223 `
  -codex-home "$env:LOCALAPPDATA\AetherOps\v2\codex-home" `
  -details-out .\build\production-feed.details.json `
  -receipt-out .\build\production-feed.receipt.json
```

The executable first authenticates the full ledger chain and the candidate,
then compares the candidate's `runtime-trust-diagnostic` output to the trust
file. It accepts only a DNS hostname on HTTPS port 443. Its network transport
uses system certificate roots, bypasses environment proxies, resolves every
destination itself, and rejects loopback, private, link-local, metadata-like,
documentation, benchmarking, and other reserved addresses.

The signed `FeedClient` observation records hashes of the exact envelope,
signed payload, and TLS leaf certificate. `Manager.Stage` performs the real
eight-component download, SHA-256, Ed25519 attestation, npm SRI, extraction,
App Server `initialize`/`model/list`, and browser MCP `list_pages`/snapshot
checks. A second Manager instance then invokes `Updater.ActivateOnStartup`,
which re-verifies and activates the pending set through the product's required
restart path. Only after active-state and
process-path readback, isolated-root cleanup, and final candidate/ledger
re-authentication are the typed details and receipt written.

There is no injectable HTTP client or compatibility probe in the command.
Local unit fixtures test rejection and state-contract mechanics only; they
cannot produce gate-eligible evidence. If the real feed, public key, system TLS,
CDP endpoint, exact models, or any artifact/probe is unavailable, the command
fails without writing a passing receipt.

# Live authenticated model-catalog evidence

`liveauthevidence` creates the release-gate evidence for
`live_auth_exact_models` from a running, packaged AetherOps release-evaluation
session on Windows 11 x64.

This command is intentionally a production-only observer. It has no flags for
an endpoint, bearer token, model list, account result, timestamps, or a passing
status. Those values are taken from the protected session descriptor, direct
authenticated loopback responses, and fixed product contracts.

## Preconditions

1. Build the exact release candidate so these files share one package root:
   `aetherops.exe`, `runtime-manifest.json`, and
   `knowledge-sidecar/index.cjs`.
2. Prepare the release ledger for that exact `ProductBuild`. Its
   `live_auth_exact_models` evidence row must still be empty.
3. Start the packaged `aetherops.exe release-eval-session` flow and complete
   real ChatGPT device-code authentication, supplying an explicit owned
   evaluation `--data-root`. Use its descriptor path directly;
   do not copy or relax the ACL on the descriptor or token sibling.
4. Keep that exact process and the prepared ledger unchanged while evidence is
   captured.

Run:

```powershell
go run ./cmd/liveauthevidence `
  -ledger C:\absolute\release\release-ledger.json `
  -out C:\absolute\release\live-auth-exact-models.receipt.json `
  -descriptor C:\absolute\protected\release-eval-session.json `
  -aetherops-exe C:\absolute\package\aetherops.exe `
  -runtime-manifest C:\absolute\package\runtime-manifest.json `
  -knowledge-sidecar C:\absolute\package\knowledge-sidecar\index.cjs
```

The output and generated `.details.json` sibling are created exclusively. An
existing output is never overwritten.

## What is proved

The producer binds the immediate prepared ledger, exact packaged
`ProductBuild`, live process executable, protected descriptor and token files,
loopback endpoint, response bodies, and observation times. It then requires:

- a genuinely authenticated, managed ChatGPT account with a non-empty plan;
- `gpt-5.6-sol` with `xhigh` and `standard` support;
- `gpt-5.6-terra` with `high` and `standard` support;
- the exact default `gpt-5.6-sol` / `xhigh` / `standard` configuration; and
- ready Windows/amd64 status from the same packaged product build.

Authentication secrets are never written to evidence, hashed into evidence,
or accepted on the command line. The command contacts only the descriptor's
canonical `http://127.0.0.1:<port>` endpoint, disables proxy use and redirects,
and re-authenticates every mutable input immediately before its exclusive
output commit.

The typed verifier is
`releasegate.ValidateLiveAuthExactModelsEvidenceForLedger`. Admission into the
global release-gate policy and dispatch table is coordinated separately so its
required subject set and immediate-ledger checks cannot be partially enabled.

## Failure behavior

Any missing exact model or effort, non-standard service tier, unauthenticated
or non-ChatGPT account, changed candidate/process/session/ledger, weak session
ACL, malformed response, timeout, redirect, or output collision fails closed.
No mock success path, provider fallback, alternate model, localhost alias, or
partial receipt is produced.

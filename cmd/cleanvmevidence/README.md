# Clean Windows 11 VM release evidence

`cleanvmevidence` is the only intended producer for the `clean_vm_installer`
and `clean_vm_portable` release gates. It is deliberately unusable as a
package smoke-test shortcut.

The release-build host first runs `capture-host` against the exact current
prepared-ledger revision and source tree. The generated reference contains no
MachineGuid, SID, firmware serial, or account value; only domain-separated
SHA-256 identities are retained.

Each package scenario then runs on a fresh Windows 11 x64 VM. The campaign
draft and retained observation artifacts must cover the exact fourteen checks
defined by `cleanvmevidence.RequiredCheckIDs()`. The campaign is production
eligible only when all of these conditions are observed:

- no prior AetherOps program, data root, or WebView2 profile;
- both final package hashes match the exact two-line `SHA256SUMS.txt` and the
  portable archive contains the ledger-bound candidate without unsafe ZIP
  paths or case-folding collisions;
- real ChatGPT OAuth plus the actual 12-case evaluation runner and offline
  quality verifier (12/12, including six engineering cases);
- solver receipt, RDF snapshot, read-only SPARQL result, graph curation event,
  CAS readback, and SQLite observation artifacts;
- a distinct process after restart with the same graph head, readable graph,
  and retained authenticated profile;
- a failed runtime candidate in durable `quarantined` state, the last verified
  runtime still active, persistent warning, and no automatic retry;
- default silent uninstall removes the program while preserving byte-identical
  data/profile markers, followed by reinstall and explicit `/DELETEUSERDATA`
  purge that removes the program, data root, and browser profile.

All authenticated inputs and observation artifacts must be direct siblings of
the current prepared ledger. Outputs are created exclusively and fsynced.
Finalization re-reads the prepared ledger and current VM identity immediately
before emission. A fixture, a partial campaign, a non-VM host, the build host,
or a changed candidate cannot emit a passing receipt.

`finalize` intentionally emits the receipt but does not attach it to the
ledger. The fixed release-gate policy accepts this producer for only the two
clean-VM gate IDs. Admission re-reads the exact predecessor-bound host
reference, packages, dataset, runner/quality receipts, and all fourteen
observation artifacts; it rejects missing, extra, reused, redirected, or
changed siblings before the receipt can be attached.

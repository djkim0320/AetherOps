# Aerospace architecture decisions

## AER-001 — Canonical state remains authoritative

`RunStateRevision` in SQLite remains the source of truth. `EngineeringRunState` is a deterministic domain projection and must not become an independent persistence authority. A future storage cutover must embed or reference the aerospace projection through versioned typed events, worker-side optimistic concurrency and existing atomic state/event/checkpoint transactions.

## AER-002 — Physical quantities are explicit

Every engineering scalar uses a dimension vector, original unit, SI value, semantic kind and provenance. Mass/force, absolute/delta temperature, gauge/absolute pressure and angle are intentionally distinct. Unsupported or ambiguous input fails instead of receiving a unit guess.

## AER-003 — Equations execute outside the model

The model may select a registered equation but cannot supply authoritative arithmetic. Activation requires dimensional, source and implementation evidence. Execution produces input lineage, dimension and sanity-check receipts.

## AER-004 — Verification and validation are separate

Model cards retain separate verification and validation domains. Proposed use is evaluated deterministically. Outside-domain results receive a placard and cannot be promoted as completed simulation evidence.

## AER-005 — Public datasets are immutable evidence

The NASA TMR Ladson force file is stored byte-for-byte with source, access date, license and SHA-256 metadata. Runtime adapters must compute the observed hash; a caller-provided hash alone is not authoritative.

## AER-006 — Transition is part of the solver contract

WebXFOIL now records free versus forced boundary-layer transition. Forced transition requires explicit upper/lower x/c locations and a source evidence ID. Solver artifacts and evidence include the transition policy so a free-transition result cannot silently masquerade as the tripped NASA validation condition.

## AER-007 — Dynamic tool loading is policy-first

Aerospace tool routing first applies capability, fidelity, license, risk and frame hard filters, then ranks eligible descriptors. Only selected schemas count toward prompt loading. A 1,000-tool deterministic test proves selection mechanics; it does not establish real catalog recall.

## AER-008 — Research dossiers expose gaps

The fixed-wing slice produces traceable outputs, uncertainty, sensitivity, requirements coverage, assumptions and unresolved gaps. It explicitly prohibits certification findings, flight release, unreviewed safety decisions and hardware control.

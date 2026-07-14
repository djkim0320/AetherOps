# AetherAeroBench 0.1

AetherAeroBench is the offline, fail-closed promotion harness for the implemented aerospace domain boundary. It is not evidence of aircraft certification, flight safety, or general solver validity.

## Commands

```text
npm run aerospace:verify
npm run aerospace:eval
```

Both commands use the repository-pinned Vitest runtime. The worker policy is bounded to the existing Vitest maximum while retaining deterministic result ordering. The post-audit verified run on 2026-07-15 used 4 workers on a 16-logical-core host and passed 64/64 tests in 3,953.675 ms. The evaluation profile passed the same 64/64 gates in 3,928.098 ms.

Verification evidence receipt:

```json
{
  "evidenceClass": "offline-real-runtime",
  "externalNetworkRequests": 0,
  "semanticResultHash": "0e14283417bf63985d162b9b9a7863503d87d66878ec628da6834eed504a8254",
  "receiptHash": "2935321523925dd6ff10c0aac020931a87d15e962207615421564b9198503963"
}
```

Evaluation evidence receipt:

```json
{
  "evidenceClass": "offline-real-runtime",
  "externalNetworkRequests": 0,
  "semanticResultHash": "04969b71f06a2d1503a2ed4181d419e42baede53a143c4ca0a55d5ed265ecada",
  "receiptHash": "341d0209dfd86c5acf14e86c9b4fba163f021ef70e08d8258904e7e3bc4efa74"
}
```

Each receipt is run-specific. The semantic hash covers the execution mode, evidence class, test counts and gate classifications; it excludes duration and wall-clock time.

## Implemented suites

| Suite                           | Current evidence                                                                                                                                                | Boundary                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Units and dimensions            | SI normalization, SI/US customary conversion, mass/force, absolute/delta temperature, gauge/absolute pressure, angle, compound units, uncertainty and precision | Unit catalog is intentionally bounded; unsupported units fail                                    |
| Coordinate frames               | Registry, NED/ENU mismatch rejection, body/wind conventions, active/passive DCM, quaternion ordering, orthonormality and round trip                             | Inertia-tensor transformation remains unimplemented                                              |
| Atmosphere and flight condition | Source-bound ISA troposphere, Mach, dynamic pressure and Reynolds number                                                                                        | Valid only for 0-11,000 m; no silent extension                                                   |
| Analytical engineering          | Research-only fixed-wing point-performance dossier with equation receipts, requirements, model-use assessment, uncertainty, sensitivity and unresolved gaps     | No field performance, propulsion map, structural substantiation or certification assessment      |
| Source and traceability         | Project isolation, source hash/revision metadata, requirement-claim-evidence bidirectional coverage and human-only acceptance                                   | Standards applicability search is not yet integrated                                             |
| Model credibility               | Separate verification/validation domains, outside-domain placards, convergence and terminal receipt gates                                                       | Independent solver reproduction is not yet a release gate                                        |
| Tool routing                    | Hard capability/fidelity/license/frame filters and deferred top-k schema loading over a 1,000-tool synthetic catalog                                            | This is routing-mechanics evidence, not production catalog quality evidence                      |
| Aerodynamic validation          | Real bundled `webxfoil-wasm@0.1.1`, two alpha-sequence runs, source-bound forced transition, immutable NASA data, error metrics and domain placards             | Experimental uncertainty is not present in the pinned force-data file and is reported as unknown |

## Public aerodynamic reference

- Case: NASA Turbulence Modeling Resource, 2DN00 NACA 0012 validation.
- Force data: Ladson, NASA-TM-4074, `Re=6,000,000`, `M=0.15`, tripped transition.
- Fixture: `tests/fixtures/aerospace/naca0012-ladson-re6m-m015.dat`.
- Fixture SHA-256: `78cd2f6aa4968e80f44cbf6c96f699bd9c6e45681d958ec528a10cf72ed23357`.
- Access date: 2026-07-15.
- License record: NASA NTRS marks the report public and a work of the US Government for which public use is permitted.
- Geometry: generated deterministically from the sharp-trailing-edge formula published by NASA TMR. The generated geometry is hashed before solver binding.

The validator never extrapolates reference data. It requires at least four in-domain comparison points, finite metrics, a passing model-use assessment, convergence evidence and configured acceptance thresholds. The benchmark uses maximum lift RMSE 0.2 and maximum drag RMSE 0.015 for this research fixture; these thresholds are test criteria, not certification tolerances.

## Evidence classification

- `deterministic fixture`: unit, frame, traceability and failure-path tests.
- `public recorded data`: immutable NASA force data with source and content hash.
- `real local solver`: bundled WebXFOIL executed without external network access.
- `not evaluated`: live provider behavior, certification applicability, flight safety and installed external CFD suites.

No mock or synthetic solver result is counted as aerodynamic-validation success. The small recorded-result parser test proves validator mechanics only and is separate from the real WebXFOIL integration gate.

## Remaining promotion blockers

- Aerospace state is not yet persisted as a worker-owned typed payload within canonical `RunStateRevision`; the current `EngineeringRunState` is a pure domain projection.
- A slice-specific forced context reset and real server restart readback are not part of this receipt. Existing generic harness recovery remains the only restart evidence.
- Compute sandbox qualification and shadow/canary production routing are incomplete for the new aerospace metadata.
- Standards applicability, independent verification, engineering memory invalidation and renderer inspection are deferred to later milestones without placeholder tables or UI.

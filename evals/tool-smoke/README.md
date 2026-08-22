# Engineering CLI smoke tests

`run_cli_solvers.ps1` executes two real, pinned aerodynamic solvers without using
`PATH`, a shell command wrapper, mocks, or synthetic solver output:

- XFOIL 6.99: NACA0012, Re=1,000,000, Mach 0.10, alpha 0/2/4 degrees.
- SU2 8.5.0 `win64-omp`: the unmodified NACA0012 configuration and mesh from
  the official `v8.5.0/QuickStart` directory.

Run from the repository root:

```powershell
& .\evals\tool-smoke\run_cli_solvers.ps1
```

The first run downloads the exact official archives into
`build\tool-smoke\official-cache`; every archive, nested archive, input, and
executable is checked against its pinned SHA-256 before execution. Later runs
reuse only those verified files. A hash mismatch fails closed.

The SU2 command is equivalent to:

```text
SU2_CFD.exe -t <logical-processor-count> inv_NACA0012.cfg
```

`OMP_NUM_THREADS` is set to the same count and `OMP_DYNAMIC=FALSE`. Both
processes run with no window and have a 180-second default timeout. The test
requires finite coefficients, positive drag, a monotonic XFOIL lift sweep, a
successful SU2 convergence marker, and an SU2 final density residual at or below
-8.

The machine-readable result is written atomically to
`build\tool-smoke\cli-solvers-receipt.json`. It records official URLs, exact
arguments and environment, runtime duration, coefficients, convergence data,
and SHA-256 hashes for inputs, executables, logs, and solver artifacts.

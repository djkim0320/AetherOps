# AetherOps Embedded Engineering Toolchain

Place the real open-source engineering program archives here after installation:

- `openvsp/` containing `vspscript.exe` and VSPAERO tools from OpenVSP.
- `xflr5/` containing `xflr5.exe`.
- `su2/` containing `SU2_CFD.exe`.
- Optional `xfoil/` containing `xfoil.exe`; XFOIL-WASM is already provided by the app dependency.

Run `node scripts/engineering/install-embedded-toolchain.mjs` from the repository root to populate this directory from official release downloads.

AetherOps does not use PATH fallback for engineering programs. Bare executable names are resolved only inside this directory. Absolute or relative executable paths are treated as explicit custom overrides.

module.exports = {
  options: {
    baseDir: ".",
    parser: "tsc",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: "^(?:node_modules|dist|dist-server|coverage|playwright-report|\\.tmp|\\.aetherops|vendor|tmp)(?:/|$)"
    }
  },
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "core-is-platform-free",
      severity: "error",
      comment: "Domain code is pure TypeScript and cannot depend on Node, React, or outer layers.",
      from: { path: "^src/core/" },
      to: {
        path: "^(?:node:|react(?:/|$)|react-dom(?:/|$)|playwright(?:/|$)|src/(?:server|renderer)/)",
        dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "local", "localmodule"]
      }
    },
    {
      name: "core-does-not-reach-outer-layers",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/(?:server|renderer)/" }
    },
    {
      name: "renderer-crosses-through-contracts-only",
      severity: "error",
      comment: "Renderer cross-layer imports must use the public API contracts.",
      from: { path: "^src/renderer/" },
      to: { path: "^src/(?:core|server|migration|shared)/" }
    },
    {
      name: "renderer-has-no-node-builtins",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { dependencyTypes: ["core"] }
    },
    {
      name: "server-does-not-import-renderer",
      severity: "error",
      from: { path: "^src/server/" },
      to: { path: "^src/renderer/" }
    },
    {
      name: "contracts-only-import-contracts-or-kernel",
      severity: "error",
      from: { path: "^src/contracts/" },
      to: {
        path: "^src/",
        pathNot: "^src/(?:contracts/|shared/kernel/)"
      }
    },
    {
      name: "contracts-have-no-platform-dependencies",
      severity: "error",
      from: { path: "^src/contracts/" },
      to: { dependencyTypes: ["core"] }
    },
    {
      name: "contracts-only-use-zod-externally",
      severity: "error",
      from: { path: "^src/contracts/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-unknown"],
        pathNot: "^(?:node_modules/)?zod(?:/|$)"
      }
    },
    {
      name: "feature-imports-use-public-entrypoints",
      severity: "error",
      comment: "A feature may use its own internals; cross-feature imports must target public.ts.",
      from: { path: "^src/renderer/features/([^/]+)/" },
      to: {
        path: "^src/renderer/features/(?!$1/)[^/]+/",
        pathNot: "^src/renderer/features/[^/]+/public\\.ts$"
      }
    }
  ]
};

# AetherOps

AetherOps is a desktop MVP for a project-based autonomous research agent. It follows a fixed research loop:

1. Create a research project
2. Create sub conversation sessions
3. Create an isolated research database
4. Generate research questions, hypotheses, and seed evidence
5. Run OpenCode as the execution engine
6. Store outputs and source material
7. Build a RAG context
8. Derive evidence-based results
9. Finalize research outputs

## Run

On Windows, double-click:

```bat
AetherOps.vbs
```

Or run from a terminal:

```bash
npm install
npm run build
npm run electron:dev
```

## Notes

- AetherOps uses Codex OAuth as the orchestrator LLM provider when available.
- OpenCode execution LLM settings can be configured in the app with API or Codex OAuth options.
- Current OpenCode execution is wired through a mock adapter ready to be replaced by the real OpenCode SDK/server adapter.

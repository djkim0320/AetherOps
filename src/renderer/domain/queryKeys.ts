export const shellQueryKeys = {
  health: () => ["health"] as const,
  projects: {
    all: () => ["projects"] as const,
    detail: (projectId: string) => ["projects", projectId] as const,
    snapshot: (projectId: string) => ["projects", projectId, "snapshot"] as const,
    pendingChat: (projectId: string) => ["projects", projectId, "pending-chat"] as const,
    jobs: (projectId: string) => ["projects", projectId, "jobs"] as const,
    events: (projectId: string) => ["projects", projectId, "events"] as const
  },
  settings: () => ["settings"] as const,
  llmStatus: () => ["llm", "status"] as const,
  toolsDiagnostics: () => ["tools", "diagnostics"] as const
} as const;

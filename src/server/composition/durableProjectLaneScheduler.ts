interface ProjectLaneSchedulerOptions {
  concurrency: number;
  canRun(): boolean;
  drain(projectId: string): Promise<boolean>;
  onFailure(error: unknown, projectId: string): void;
  onActiveChanged(activeProjects: number): void;
}

/** Fair one-job-per-turn scheduler with a process-local project lifetime guard. */
export class DurableProjectLaneScheduler {
  private readonly scheduled = new Set<string>();
  private readonly activeProjects = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<boolean>>();
  private pumping = false;

  constructor(private readonly options: ProjectLaneSchedulerOptions) {}

  schedule(projectId: string): void {
    if (!this.options.canRun()) return;
    this.scheduled.add(projectId);
    queueMicrotask(() => this.pump());
  }

  activePromises(): Iterable<Promise<boolean>> {
    return this.activeRuns.values();
  }

  clearScheduled(): void {
    this.scheduled.clear();
  }

  private pump(): void {
    if (this.pumping || !this.options.canRun()) return;
    this.pumping = true;
    try {
      while (this.activeProjects.size < this.options.concurrency) {
        const projectId = [...this.scheduled].find((candidate) => !this.activeProjects.has(candidate));
        if (!projectId) break;
        this.scheduled.delete(projectId);
        this.activeProjects.add(projectId);
        const run = Promise.resolve().then(() => this.options.drain(projectId));
        this.activeRuns.set(projectId, run);
        this.options.onActiveChanged(this.activeProjects.size);
        void run.then(
          (claimed) => this.complete(projectId, claimed),
          (error) => {
            this.options.onFailure(error, projectId);
            this.complete(projectId, false);
          }
        );
      }
    } finally {
      this.pumping = false;
    }
  }

  private complete(projectId: string, claimed: boolean): void {
    this.activeRuns.delete(projectId);
    this.activeProjects.delete(projectId);
    this.options.onActiveChanged(this.activeProjects.size);
    if (claimed) this.schedule(projectId);
    this.pump();
  }
}

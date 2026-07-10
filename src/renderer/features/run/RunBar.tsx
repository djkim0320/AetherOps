import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pause, Play, RotateCw, Square } from "lucide-react";
import { type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { jobApi } from "../../domain/jobApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectJobsQueryOptions, projectSnapshotQueryOptions } from "../../domain/queryOptions.js";
import type { ProjectEventStreamState } from "../../platform/sseClient.js";
import { requestProjectEventReconnect } from "../../app/ProjectEventsBridge.js";
import styles from "./RunBar.module.css";

export function RunBar({ projectId }: { projectId: string }): ReactElement {
  const client = useQueryClient();
  const snapshot = useQuery(projectSnapshotQueryOptions(projectId));
  const jobs = useQuery(projectJobsQueryOptions(projectId));
  const stream = client.getQueryData<ProjectEventStreamState>(shellQueryKeys.projects.events(projectId));
  const execution = snapshot.data?.execution;
  const activeJob = jobs.data?.jobs.find((job) => job.id === execution?.activeJobId) ?? jobs.data?.jobs[0];
  const command = useMutation({
    mutationFn: async (action: "start" | "pause" | "resume" | "abort") => {
      const idempotencyKey = crypto.randomUUID();
      if (action === "start") return jobApi.start({ projectId, idempotencyKey });
      if (action === "pause" && activeJob && execution) return jobApi.pause({ projectId, jobId: activeJob.id, expectedProjectRevision: execution.revision });
      if (action === "abort" && activeJob && execution) return jobApi.abort({ projectId, jobId: activeJob.id, expectedProjectRevision: execution.revision });
      if (action === "resume" && activeJob && execution?.lastCheckpointId)
        return jobApi.resume({ projectId, idempotencyKey, interruptedJobId: activeJob.id, checkpointId: execution.lastCheckpointId });
      throw new Error("This action is not available for the current project state.");
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
      void client.invalidateQueries({ queryKey: shellQueryKeys.projects.jobs(projectId) });
    }
  });
  const status = execution?.status ?? "idle";
  const disconnected = stream && stream.status !== "open" && stream.status !== "connecting";
  return (
    <section className={styles.bar} data-ui="run-bar" aria-label="Research run">
      <Badge variant={statusVariant(status)}>{status}</Badge>
      <span className={styles.step}>{execution?.currentStep ?? "Ready"}</span>
      {disconnected ? (
        <span className={styles.stale}>
          <AlertTriangle aria-hidden="true" />
          Data may be stale
        </span>
      ) : null}
      <div className={styles.actions}>
        {disconnected ? (
          <Button variant="ghost" size="sm" onClick={() => requestProjectEventReconnect(projectId)}>
            <RotateCw aria-hidden="true" />
            Reconnect
          </Button>
        ) : null}
        {canStart(status) ? (
          <Button size="sm" onClick={() => command.mutate("start")} disabled={command.isPending}>
            <Play aria-hidden="true" />
            Start
          </Button>
        ) : null}
        {status === "running" ? (
          <Button variant="secondary" size="sm" onClick={() => command.mutate("pause")} disabled={command.isPending}>
            <Pause aria-hidden="true" />
            Pause
          </Button>
        ) : null}
        {canResume(status, Boolean(execution?.lastCheckpointId)) ? (
          <Button size="sm" onClick={() => command.mutate("resume")} disabled={command.isPending}>
            <Play aria-hidden="true" />
            Resume
          </Button>
        ) : null}
        {canAbort(status) ? (
          <Button variant="danger" size="sm" onClick={() => command.mutate("abort")} disabled={command.isPending}>
            <Square aria-hidden="true" />
            Abort
          </Button>
        ) : null}
      </div>
      {command.error ? (
        <span role="alert" className={styles.error}>
          {command.error.message}
        </span>
      ) : null}
    </section>
  );
}
function canStart(status: string): boolean {
  return ["idle", "completed", "aborted", "failed"].includes(status);
}
function canResume(status: string, checkpoint: boolean): boolean {
  return checkpoint && ["paused", "interrupted", "blocked"].includes(status);
}
function canAbort(status: string): boolean {
  return ["queued", "running", "pause_requested", "paused", "cancel_requested"].includes(status);
}
function statusVariant(status: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (["failed", "blocked", "interrupted", "aborted"].includes(status)) return "danger";
  if (status === "idle") return "neutral";
  return "accent";
}

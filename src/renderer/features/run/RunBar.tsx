import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pause, Play, RotateCw, Square } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { jobApi } from "../../domain/jobApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectJobsQueryOptions, projectQueryOptions, projectSnapshotQueryOptions, settingsQueryOptions } from "../../domain/queryOptions.js";
import type { ProjectEventStreamState } from "../../platform/sseClient.js";
import { requestProjectEventReconnect } from "../../app/ProjectEventsBridge.js";
import { RunPolicyDialog, type ConfirmedRunPolicy } from "./RunPolicyDialog.js";
import styles from "./RunBar.module.css";
import { ko, localizeCapabilityReason, localizeError, statusLabel, stepLabel } from "../../platform/i18n.js";

type RunCommand = { action: "start" | "resume"; policy: ConfirmedRunPolicy } | { action: "pause" | "abort" };

export function RunBar({ projectId }: { projectId: string }): ReactElement {
  const client = useQueryClient();
  const project = useQuery(projectQueryOptions(projectId));
  const settings = useQuery(settingsQueryOptions());
  const snapshot = useQuery(projectSnapshotQueryOptions(projectId));
  const jobs = useQuery(projectJobsQueryOptions(projectId));
  const stream = client.getQueryData<ProjectEventStreamState>(shellQueryKeys.projects.events(projectId));
  const execution = snapshot.data?.execution;
  const activeJob = jobs.data?.jobs.find((job) => job.id === execution?.activeJobId) ?? jobs.data?.jobs[0];
  const [policyAction, setPolicyAction] = useState<"start" | "resume">();
  const maximum = useMemo(() => {
    const projectCapabilities = project.data?.capabilities;
    const appCapabilities = settings.data?.capabilities;
    if (!projectCapabilities || !appCapabilities) return undefined;
    return {
      agent: projectCapabilities.agent && appCapabilities.agent,
      engineering: projectCapabilities.engineering && appCapabilities.engineering,
      search: projectCapabilities.search && appCapabilities.search
    };
  }, [project.data?.capabilities, settings.data?.capabilities]);
  const command = useMutation({
    mutationFn: async (command: RunCommand) => {
      const idempotencyKey = crypto.randomUUID();
      if (command.action === "start") return jobApi.start({ projectId, idempotencyKey, ...command.policy });
      if (command.action === "pause" && activeJob && execution)
        return jobApi.pause({ projectId, jobId: activeJob.id, expectedProjectRevision: execution.revision });
      if (command.action === "abort" && activeJob && execution)
        return jobApi.abort({ projectId, jobId: activeJob.id, expectedProjectRevision: execution.revision });
      if (command.action === "resume" && activeJob && execution?.lastCheckpointId)
        return jobApi.resume({
          projectId,
          idempotencyKey,
          interruptedJobId: activeJob.id,
          checkpointId: execution.lastCheckpointId,
          ...command.policy
        });
      throw new Error("현재 프로젝트 상태에서는 이 작업을 사용할 수 없습니다.");
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
      void client.invalidateQueries({ queryKey: shellQueryKeys.projects.jobs(projectId) });
    }
  });
  const status = execution?.status ?? "idle";
  const terminalReason = activeJob?.blockedReason ?? activeJob?.failureReason;
  const disconnected = stream && stream.status !== "open" && stream.status !== "connecting";
  return (
    <section className={styles.bar} data-ui="run-bar" aria-label={ko.researchRun}>
      <div className={styles.primaryRow}>
        <div className={styles.runState} aria-live="polite">
          <span className={styles.statusDot} data-status={status} aria-hidden="true" />
          <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
          <span className={styles.step}>{stepLabel(execution?.currentStep)}</span>
        </div>
        {disconnected ? (
          <span className={styles.stale}>
            <AlertTriangle aria-hidden="true" />
            {ko.updatesDisconnected}
          </span>
        ) : null}
        <div className={styles.actions}>
          {disconnected ? (
            <Button variant="ghost" size="sm" onClick={() => requestProjectEventReconnect(projectId)}>
              <RotateCw aria-hidden="true" />
              {ko.reconnect}
            </Button>
          ) : null}
          {canStart(status) ? (
            <Button size="sm" onClick={() => setPolicyAction("start")} disabled={command.isPending || !maximum}>
              <Play aria-hidden="true" />
              {ko.start}
            </Button>
          ) : null}
          {status === "running" ? (
            <Button variant="secondary" size="sm" onClick={() => command.mutate({ action: "pause" })} disabled={command.isPending}>
              <Pause aria-hidden="true" />
              {ko.pause}
            </Button>
          ) : null}
          {canResume(status, Boolean(execution?.lastCheckpointId)) ? (
            <Button size="sm" onClick={() => setPolicyAction("resume")} disabled={command.isPending || !maximum}>
              <Play aria-hidden="true" />
              {ko.resume}
            </Button>
          ) : null}
          {canAbort(status) ? (
            <Button variant="danger" size="sm" onClick={() => command.mutate({ action: "abort" })} disabled={command.isPending}>
              <Square aria-hidden="true" />
              {ko.abort}
            </Button>
          ) : null}
        </div>
      </div>
      {command.error ? (
        <span role="alert" className={styles.error}>
          {localizeError(command.error)}
        </span>
      ) : null}
      {terminalReason ? (
        <span role="alert" className={styles.runReason}>
          <AlertTriangle aria-hidden="true" />
          <strong>{activeJob?.blockedReason ? ko.runBlocked : ko.runFailed}:</strong> {localizeCapabilityReason(terminalReason)}
        </span>
      ) : null}
      {maximum && policyAction ? (
        <RunPolicyDialog
          open
          action={policyAction}
          maximum={maximum}
          onOpenChange={(open) => {
            if (!open) setPolicyAction(undefined);
          }}
          onConfirm={(policy) => command.mutate({ action: policyAction, policy })}
        />
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

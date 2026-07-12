import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, type ReactElement } from "react";
import { shellQueryKeys } from "../domain/queryKeys.js";
import type { ProjectSnapshot } from "../../contracts/api-v2/snapshots.js";
import { connectProjectEventStream, type ProjectEventStreamState } from "../platform/sseClient.js";
import { projectEventsUrl } from "../platform/rpcTransport.js";

export function ProjectEventsBridge({ projectId }: { projectId: string }): ReactElement | null {
  const queryClient = useQueryClient();
  const [reconnectVersion, reconnect] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const eventName = `project-events:reconnect:${projectId}`;
    window.addEventListener(eventName, reconnect);
    return () => window.removeEventListener(eventName, reconnect);
  }, [projectId]);
  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | undefined;
    let refreshInFlight = false;
    let refreshSnapshot = false;
    let refreshJobs = false;
    const refreshJobIds = new Set<string>();

    function hasPendingRefresh(): boolean {
      return refreshSnapshot || refreshJobs || refreshJobIds.size > 0;
    }
    function scheduleRefresh(options: { snapshot?: boolean; jobs?: boolean; jobId?: string }): void {
      refreshSnapshot ||= options.snapshot === true;
      refreshJobs ||= options.jobs === true;
      if (options.jobId) refreshJobIds.add(options.jobId);
      if (disposed || refreshInFlight || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => void flushRefresh(), 16);
    }
    async function flushRefresh(): Promise<void> {
      refreshTimer = undefined;
      if (disposed || !hasPendingRefresh()) return;
      const snapshot = refreshSnapshot;
      const jobs = refreshJobs;
      const jobIds = [...refreshJobIds];
      refreshSnapshot = false;
      refreshJobs = false;
      refreshJobIds.clear();
      refreshInFlight = true;
      try {
        await Promise.all([
          ...(snapshot ? [queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) })] : []),
          ...(jobs ? [queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.jobs(projectId) })] : []),
          ...jobIds.map((jobId) => queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.job(projectId, jobId) }))
        ]);
      } finally {
        refreshInFlight = false;
        if (hasPendingRefresh()) scheduleRefresh({});
      }
    }

    const disconnect = connectProjectEventStream({
      url: projectEventsUrl(projectId),
      initialRevision: queryClient.getQueryData<{ revision: number }>(shellQueryKeys.projects.snapshot(projectId))?.revision,
      onStateChange: (state) => {
        queryClient.setQueryData<ProjectEventStreamState>(shellQueryKeys.projects.events(projectId), (current) =>
          sameStreamState(current, state) ? current : state
        );
        if (state.status === "gap") scheduleRefresh({ snapshot: true });
      },
      onEvent: (event) => {
        if (event.type === "project.snapshot.changed" || event.type === "run.status.changed" || event.type === "run.step.changed") {
          scheduleRefresh({ snapshot: true, jobs: true });
        }
        if (event.type === "tool.run.changed" || event.type === "artifact.created") {
          scheduleRefresh({ jobs: true, jobId: event.data.jobId });
        }
        if (event.type === "chat.message.appended") {
          queryClient.setQueryData<ProjectSnapshot>(shellQueryKeys.projects.snapshot(projectId), (snapshot) => {
            if (!snapshot) return snapshot;
            const messages = Array.isArray(snapshot.data.messages) ? snapshot.data.messages : [];
            const revision = Math.max(snapshot.revision, event.projectRevision);
            const isDuplicate = messages.some(
              (message) => typeof message === "object" && message !== null && "id" in message && message.id === event.data.message.id
            );
            if (isDuplicate) return revision === snapshot.revision ? snapshot : { ...snapshot, revision };
            return { ...snapshot, revision, data: { ...snapshot.data, messages: [...messages, event.data.message] } };
          });
          scheduleRefresh({ snapshot: true });
        }
      }
    });
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      disconnect();
    };
  }, [projectId, queryClient, reconnectVersion]);
  return null;
}

function sameStreamState(current: ProjectEventStreamState | undefined, next: ProjectEventStreamState): boolean {
  return current?.status === next.status && current.message === next.message && current.lastEventId === next.lastEventId && current.revision === next.revision;
}

export function requestProjectEventReconnect(projectId: string): void {
  window.dispatchEvent(new Event(`project-events:reconnect:${projectId}`));
}

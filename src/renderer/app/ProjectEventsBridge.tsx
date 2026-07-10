import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, type ReactElement } from "react";
import { shellQueryKeys } from "../domain/queryKeys.js";
import type { ProjectSnapshot } from "../../contracts/api-v2/snapshots.js";
import { connectProjectEventStream } from "../platform/sseClient.js";
import { projectEventsUrl } from "../platform/rpcTransport.js";

export function ProjectEventsBridge({ projectId }: { projectId: string }): ReactElement | null {
  const queryClient = useQueryClient();
  const [reconnectVersion, reconnect] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const eventName = `project-events:reconnect:${projectId}`;
    window.addEventListener(eventName, reconnect);
    return () => window.removeEventListener(eventName, reconnect);
  }, [projectId]);
  useEffect(
    () =>
      connectProjectEventStream({
        url: projectEventsUrl(projectId),
        initialRevision: queryClient.getQueryData<{ revision: number }>(shellQueryKeys.projects.snapshot(projectId))?.revision,
        onStateChange: (state) => {
          queryClient.setQueryData(shellQueryKeys.projects.events(projectId), state);
          if (state.status === "gap") void queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
        },
        onEvent: (event) => {
          if (event.type === "project.snapshot.changed" || event.type === "run.status.changed" || event.type === "run.step.changed") {
            void queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
            void queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.jobs(projectId) });
          }
          if (event.type === "chat.message.appended") {
            queryClient.setQueryData<ProjectSnapshot>(shellQueryKeys.projects.snapshot(projectId), (snapshot) => {
              if (!snapshot) return snapshot;
              const messages = Array.isArray(snapshot.data.messages) ? snapshot.data.messages : [];
              if (messages.some((message) => typeof message === "object" && message !== null && "id" in message && message.id === event.data.message.id))
                return snapshot;
              return { ...snapshot, data: { ...snapshot.data, messages: [...messages, event.data.message] } };
            });
            void queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
          }
        }
      }),
    [projectId, queryClient, reconnectVersion]
  );
  return null;
}

export function requestProjectEventReconnect(projectId: string): void {
  window.dispatchEvent(new Event(`project-events:reconnect:${projectId}`));
}

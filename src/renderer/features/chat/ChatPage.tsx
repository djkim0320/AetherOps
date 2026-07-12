import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { jobApi } from "../../domain/jobApi.js";
import { projectApi } from "../../domain/projectApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectQueryOptions, projectSnapshotQueryOptions } from "../../domain/queryOptions.js";
import { ChatComposer } from "./ChatComposer.js";
import styles from "./ChatPage.module.css";
import { ChatTranscript } from "./ChatTranscript.js";
import { pendingMessagesForDisplay, selectChatMessages, type PendingChatMessage } from "./transcript.js";
import { ko } from "../../platform/i18n.js";

export function ChatPage({ newSession = false }: { newSession?: boolean }): ReactElement {
  const { projectId = "", sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const project = useQuery(projectQueryOptions(projectId));
  const snapshot = useQuery(projectSnapshotQueryOptions(projectId));
  const [draft, setDraft] = useState("");
  const pending = useQuery({
    queryKey: shellQueryKeys.projects.pendingChat(projectId),
    queryFn: async () => [] as PendingChatMessage[],
    initialData: [] as PendingChatMessage[],
    staleTime: Number.POSITIVE_INFINITY
  });
  const rawMessages = snapshot.data?.data.messages;
  const messages = useMemo(() => selectChatMessages(rawMessages, routeSessionId), [rawMessages, routeSessionId]);
  const visiblePending = useMemo(() => pendingMessagesForDisplay(messages, pending.data), [messages, pending.data]);

  useEffect(() => {
    if (samePendingMessages(visiblePending, pending.data)) return;
    queryClient.setQueryData(shellQueryKeys.projects.pendingChat(projectId), visiblePending);
  }, [pending.data, projectId, queryClient, visiblePending]);

  const send = useMutation({
    mutationFn: async ({ content, clientMutationId }: PendingChatMessage) => {
      let sessionId = routeSessionId;
      if (newSession || !sessionId) {
        const session = await projectApi.createSession({ projectId, focus: content });
        sessionId = session.id;
        navigate(`/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(session.id)}`, { replace: true });
      }
      const receipt = await jobApi.enqueueChat({ projectId, sessionId, content, clientMutationId, idempotencyKey: clientMutationId });
      await queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.snapshot(projectId) });
      return receipt;
    }
  });

  function submit(): void {
    const content = draft.trim();
    if (!content || send.isPending) return;
    const message = { content, clientMutationId: crypto.randomUUID() };
    setDraft("");
    queryClient.setQueryData<PendingChatMessage[]>(shellQueryKeys.projects.pendingChat(projectId), (items = []) => [...items, message]);
    send.mutate(message, {
      onError: () =>
        queryClient.setQueryData<PendingChatMessage[]>(shellQueryKeys.projects.pendingChat(projectId), (items = []) =>
          items.filter((item) => item.clientMutationId !== message.clientMutationId)
        )
    });
  }

  return (
    <section className={styles.chat} data-ui="chat-workspace" aria-labelledby="chat-title">
      <header className={styles.title}>
        <div>
          <p>{ko.researchConversation}</p>
          <h1 id="chat-title">{project.data?.input.topic ?? ko.unnamedProject}</h1>
        </div>
        <span>
          {messages.length} {ko.messages}
        </span>
      </header>
      <ChatTranscript messages={messages} pending={visiblePending} topic={project.data?.input.topic} />
      <ChatComposer draft={draft} sending={send.isPending} error={send.error} onDraftChange={setDraft} onSubmit={submit} />
    </section>
  );
}

function samePendingMessages(left: PendingChatMessage[], right: PendingChatMessage[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.clientMutationId === right[index]?.clientMutationId && item.content === right[index]?.content)
  );
}

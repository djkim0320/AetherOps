import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/ui/button.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { Textarea } from "../../components/ui/textarea.js";
import { jobApi } from "../../domain/jobApi.js";
import { projectApi } from "../../domain/projectApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectQueryOptions, projectSnapshotQueryOptions } from "../../domain/queryOptions.js";
import styles from "./ChatPage.module.css";
import { pendingMessagesForDisplay, selectChatMessages, type PendingChatMessage } from "./transcript.js";

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
  const composing = useRef(false);
  const messages = useMemo(() => {
    return selectChatMessages(snapshot.data?.data.messages, routeSessionId);
  }, [routeSessionId, snapshot.data]);
  const visiblePending = pendingMessagesForDisplay(messages, pending.data);
  useEffect(() => {
    if (visiblePending.length === pending.data.length) return;
    queryClient.setQueryData(shellQueryKeys.projects.pendingChat(projectId), visiblePending);
  }, [pending.data.length, projectId, queryClient, visiblePending]);

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
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !composing.current) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className={styles.chat} data-ui="chat-workspace" aria-labelledby="chat-title">
      <header className={styles.title}>
        <p>{project.data?.input.topic ?? "Project"}</p>
        <h1 id="chat-title">Research chat</h1>
      </header>
      <ScrollArea className={styles.transcript}>
        <div className={styles.messages} data-ui="chat-transcript" aria-live="polite">
          {messages.length + visiblePending.length === 0 ? (
            <div className={styles.welcome}>
              <h2>Start with a question</h2>
              <p>Your message is queued in this project&apos;s durable execution lane.</p>
            </div>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} className={styles.message} data-role={message.role}>
              <span>{message.role === "user" ? "You" : "AetherOps"}</span>
              <p>{message.content}</p>
            </article>
          ))}
          {visiblePending.map((message) => (
            <article key={message.clientMutationId} className={styles.message} data-role="user" data-pending="true">
              <span>You · pending</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
      </ScrollArea>
      <div className={styles.composer} data-ui="chat-composer">
        <Textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder="Ask a research question"
          rows={3}
        />
        <Button size="icon" onClick={submit} disabled={!draft.trim() || send.isPending} aria-label="Send message">
          <Send aria-hidden="true" />
        </Button>
        {send.error ? (
          <p role="alert" className={styles.error}>
            {send.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

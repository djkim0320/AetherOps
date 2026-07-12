import { LoaderCircle } from "lucide-react";
import { memo, useEffect, useRef, type ReactElement } from "react";
import type { ChatMessage } from "../../../contracts/api-v2/jobs.js";
import { OrbitMark } from "../../components/ui/orbit-mark.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import type { PendingChatMessage } from "./transcript.js";
import styles from "./ChatPage.module.css";
import { ko } from "../../platform/i18n.js";

interface ChatTranscriptProps {
  messages: ChatMessage[];
  pending: PendingChatMessage[];
  topic?: string;
}

export const ChatTranscript = memo(function ChatTranscript({ messages, pending, topic }: ChatTranscriptProps): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length + pending.length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [messageCount]);

  return (
    <ScrollArea className={styles.transcript}>
      <div className={styles.messages} data-ui="chat-transcript" role="log" aria-live="polite" aria-relevant="additions text">
        {messageCount === 0 ? <EmptyConversation topic={topic} /> : null}
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {pending.map((message) => (
          <PendingMessageRow key={message.clientMutationId} message={message} />
        ))}
        <div ref={endRef} aria-hidden="true" />
      </div>
    </ScrollArea>
  );
});

const MessageRow = memo(function MessageRow({ message }: { message: ChatMessage }): ReactElement {
  return (
    <article className={styles.message} data-role={message.role}>
      <MessageIdentity role={message.role} />
      <div className={styles.messageBody}>
        <p>{message.content}</p>
      </div>
    </article>
  );
});

const PendingMessageRow = memo(function PendingMessageRow({ message }: { message: PendingChatMessage }): ReactElement {
  return (
    <article className={styles.message} data-role="user" data-pending="true">
      <MessageIdentity role="user" />
      <div className={styles.messageBody}>
        <p>{message.content}</p>
        <span className={styles.pendingStatus} role="status">
          <LoaderCircle aria-hidden="true" /> {ko.queued}
        </span>
      </div>
    </article>
  );
});

function EmptyConversation({ topic }: { topic?: string }): ReactElement {
  return (
    <section className={styles.welcome} aria-label={ko.startResearchConversation}>
      <OrbitMark className={styles.welcomeMark} decorative />
      <p className={styles.eyebrow}>{ko.researchWorkspace}</p>
      <h2>{topic ? ko.explore(topic) : ko.whatToResearch}</h2>
      <p className={styles.welcomeDescription}>{ko.conversationHint}</p>
    </section>
  );
}

function MessageIdentity({ role }: { role: ChatMessage["role"] }): ReactElement {
  return (
    <div className={styles.identity} aria-hidden="true">
      {role === "assistant" ? <OrbitMark className={styles.avatarMark} decorative /> : <span>Y</span>}
      <strong>{role === "user" ? ko.you : ko.brand}</strong>
    </div>
  );
}

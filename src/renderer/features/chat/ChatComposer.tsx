import { ArrowUp } from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { Textarea } from "../../components/ui/textarea.js";
import styles from "./ChatPage.module.css";
import { ko, localizeError } from "../../platform/i18n.js";

interface ChatComposerProps {
  draft: string;
  sending: boolean;
  error?: Error | null;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}

export function ChatComposer({ draft, sending, error, onDraftChange, onSubmit }: ChatComposerProps): ReactElement {
  const composing = useRef(false);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !composing.current) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className={styles.composerDock}>
      <form className={styles.composer} data-ui="chat-composer" onSubmit={submit} aria-label={ko.message}>
        <Textarea
          aria-label={ko.message}
          aria-describedby="composer-hint"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={keyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder={ko.askResearch}
          rows={2}
        />
        <footer className={styles.composerFooter}>
          <span id="composer-hint">{ko.enterToSend}</span>
          <Button size="icon" type="submit" disabled={!draft.trim() || sending} aria-label={sending ? ko.sendingMessage : ko.sendMessage}>
            <ArrowUp aria-hidden="true" />
          </Button>
        </footer>
        {error ? (
          <p role="alert" className={styles.error}>
            {localizeError(error)}
          </p>
        ) : null}
      </form>
      <p className={styles.disclaimer}>{ko.disclaimer}</p>
    </div>
  );
}

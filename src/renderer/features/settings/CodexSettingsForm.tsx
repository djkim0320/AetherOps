import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import {
  CODEX_MODEL_CATALOG,
  CODEX_REASONING_EFFORTS,
  isCodexModelEffortCompatible,
  type CodexModelCategory,
  type CodexModelId,
  type CodexReasoningEffort,
  type SettingsResponse
} from "../../../contracts/api-v2/settings.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { settingsApi } from "../../domain/settingsApi.js";
import styles from "./Settings.module.css";

export const CODEX_MODEL_GROUPS: readonly { category: CodexModelCategory; label: string }[] = [
  { category: "recommended", label: "Recommended" },
  { category: "compatibility", label: "Compatibility" },
  { category: "experimental", label: "Experimental" }
];

export function CodexSettingsForm({ settings }: { settings: SettingsResponse }): ReactElement {
  const client = useQueryClient();
  const [model, setModel] = useState<CodexModelId>(settings.codex.model);
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort>(settings.codex.reasoningEffort);
  const [timeoutMs, setTimeoutMs] = useState(settings.codex.timeoutMs);
  const selectedModel = useMemo(() => CODEX_MODEL_CATALOG.find((entry) => entry.id === model)!, [model]);
  const validationError = getCodexSettingsValidationError(model, reasoningEffort, timeoutMs);
  const save = useMutation({
    mutationFn: () =>
      settingsApi.save({
        codex: { model, reasoningEffort, timeoutMs },
        embedding: editableEmbedding(settings),
        search: editableSearch(settings),
        capabilities: settings.capabilities
      }),
    onSuccess: (value) => client.setQueryData(shellQueryKeys.settings(), value)
  });

  return (
    <form
      className={styles.form}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!validationError) save.mutate();
      }}
    >
      <Label className={styles.field}>
        <span>Model</span>
        <Select value={model} onValueChange={(value) => setModel(value as CodexModelId)}>
          <SelectTrigger aria-label="Codex model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={styles.modelMenu}>
            {CODEX_MODEL_GROUPS.map((group, index) => (
              <ModelGroup key={group.category} {...group} separator={index > 0} />
            ))}
          </SelectContent>
        </Select>
      </Label>

      <section className={styles.modelDetails} aria-live="polite" aria-label="Selected model details">
        <div className={styles.modelTitle}>
          <strong>{selectedModel.label}</strong>
          {selectedModel.experimental ? <Badge variant="warning">Experimental</Badge> : null}
          {selectedModel.entitlement ? <Badge>{selectedModel.entitlement}</Badge> : null}
        </div>
        <p className={styles.modelDescription}>{selectedModel.description}</p>
        {selectedModel.id === "gpt-5.3-codex-spark" ? <small>ChatGPT Pro entitlement required. Text-only research preview.</small> : null}
      </section>

      <Label className={styles.field}>
        <span>Reasoning effort</span>
        <Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as CodexReasoningEffort)}>
          <SelectTrigger aria-label="Reasoning effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_REASONING_EFFORTS.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small>Maximum reasoning is available only for the GPT-5.6 family.</small>
      </Label>

      <Label className={styles.field}>
        <span>Timeout (ms)</span>
        <Input type="number" min={1000} max={900000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} />
      </Label>

      <div className={styles.actions}>
        {validationError || save.error ? (
          <p className={styles.actionError} role="alert">
            {validationError ?? save.error?.message}
          </p>
        ) : null}
        <Button type="submit" disabled={save.isPending || Boolean(validationError)}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function ModelGroup({ category, label, separator }: { category: CodexModelCategory; label: string; separator: boolean }): ReactElement {
  return (
    <>
      {separator ? <SelectSeparator className={styles.modelSeparator} /> : null}
      <SelectGroup>
        <SelectLabel className={styles.modelGroupLabel}>{label}</SelectLabel>
        {CODEX_MODEL_CATALOG.filter((entry) => entry.category === category).map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </>
  );
}

export function getCodexSettingsValidationError(model: CodexModelId, effort: CodexReasoningEffort, timeoutMs: number): string | undefined {
  if (!isCodexModelEffortCompatible(model, effort)) return `${effort} reasoning is not supported by ${model}. Choose a compatible effort to save.`;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) return "Timeout must be an integer between 1,000 and 900,000 ms.";
  return undefined;
}

function editableEmbedding(settings: SettingsResponse) {
  return {
    provider: settings.embedding.provider,
    model: settings.embedding.model,
    baseUrl: settings.embedding.baseUrl,
    dimensions: settings.embedding.dimensions
  };
}

function editableSearch(settings: SettingsResponse) {
  return { provider: settings.search.provider, endpoint: settings.search.endpoint, timeoutMs: settings.search.timeoutMs };
}

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
import { ko, localizeError, modelDescription, modelLabel, reasoningEffortLabel } from "../../platform/i18n.js";

export const CODEX_MODEL_GROUPS: readonly { category: CodexModelCategory; label: string }[] = [
  { category: "recommended", label: ko.recommended },
  { category: "compatibility", label: ko.compatibility },
  { category: "experimental", label: ko.experimentalGroup }
];

export function CodexSettingsForm({ settings }: { settings: SettingsResponse }): ReactElement {
  const client = useQueryClient();
  const [model, setModel] = useState<CodexModelId>(settings.codex.model);
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort>(settings.codex.reasoningEffort);
  const [timeoutMs, setTimeoutMs] = useState(settings.codex.timeoutMs);
  const [taskTimeoutMs, setTaskTimeoutMs] = useState(settings.codex.taskTimeoutMs);
  const selectedModel = useMemo(() => CODEX_MODEL_CATALOG.find((entry) => entry.id === model)!, [model]);
  const validationError = getCodexSettingsValidationError(model, reasoningEffort, timeoutMs, taskTimeoutMs);
  const save = useMutation({
    mutationFn: () =>
      settingsApi.save({
        codex: { model, reasoningEffort, timeoutMs, taskTimeoutMs },
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
        <span>{ko.model}</span>
        <Select value={model} onValueChange={(value) => setModel(value as CodexModelId)}>
          <SelectTrigger aria-label={ko.model}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={styles.modelMenu}>
            {CODEX_MODEL_GROUPS.map((group, index) => (
              <ModelGroup key={group.category} {...group} separator={index > 0} />
            ))}
          </SelectContent>
        </Select>
      </Label>

      <section className={styles.modelDetails} aria-live="polite" aria-label={ko.selectedModelDetails}>
        <div className={styles.modelTitle}>
          <strong>{modelLabel(selectedModel.id)}</strong>
          {selectedModel.experimental ? <Badge variant="warning">{ko.experimental}</Badge> : null}
          {selectedModel.entitlement ? <Badge>{selectedModel.entitlement}</Badge> : null}
        </div>
        <p className={styles.modelDescription}>{modelDescription(selectedModel.id)}</p>
        {selectedModel.id === "gpt-5.3-codex-spark" ? <small>{ko.sparkEntitlement}</small> : null}
      </section>

      <Label className={styles.field}>
        <span>{ko.reasoningEffort}</span>
        <Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as CodexReasoningEffort)}>
          <SelectTrigger aria-label={ko.reasoningEffort}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_REASONING_EFFORTS.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {reasoningEffortLabel(effort)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small>{ko.maxReasoningNote}</small>
      </Label>

      <Label className={styles.field}>
        <span>{ko.plannerTimeout}</span>
        <Input type="number" min={1000} max={900000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} />
      </Label>

      <Label className={styles.field}>
        <span>{ko.workspaceTaskTimeout}</span>
        <Input type="number" min={1000} max={900000} value={taskTimeoutMs} onChange={(event) => setTaskTimeoutMs(Number(event.target.value))} />
        <small>{ko.workspaceTimeoutNote}</small>
      </Label>

      <div className={styles.actions}>
        {validationError || save.error ? (
          <p className={styles.actionError} role="alert">
            {validationError ?? localizeError(save.error)}
          </p>
        ) : null}
        <Button type="submit" disabled={save.isPending || Boolean(validationError)}>
          {save.isPending ? ko.saving : ko.save}
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

export function getCodexSettingsValidationError(
  model: CodexModelId,
  effort: CodexReasoningEffort,
  timeoutMs: number,
  taskTimeoutMs = 600_000
): string | undefined {
  if (!isCodexModelEffortCompatible(model, effort)) {
    return `${reasoningEffortLabel(effort)} 추론은 ${modelLabel(model)}에서 지원되지 않습니다. 호환되는 추론 강도를 선택한 뒤 저장하세요.`;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) return ko.timeoutRange;
  if (!Number.isInteger(taskTimeoutMs) || taskTimeoutMs < 1_000 || taskTimeoutMs > 900_000) {
    return ko.workspaceTimeoutRange;
  }
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

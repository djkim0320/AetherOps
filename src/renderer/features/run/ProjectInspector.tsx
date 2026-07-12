import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { memo, useMemo, useState, type ReactElement } from "react";
import type { JobDetail } from "../../../contracts/api-v2/jobs.js";
import { Badge } from "../../components/ui/badge.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { projectJobQueryOptions, projectJobsQueryOptions, projectSnapshotQueryOptions } from "../../domain/queryOptions.js";
import styles from "./ProjectInspector.module.css";
import {
  capabilityLabel,
  formatTimestamp,
  jobKindLabel,
  ko,
  localizeCapabilityReason,
  reasoningEffortLabel,
  statusLabel,
  stepLabel,
  yesNo
} from "../../platform/i18n.js";

const InspectorItemSchema = z
  .object({ id: z.string().optional(), title: z.string().optional(), name: z.string().optional(), summary: z.string().optional(), kind: z.string().optional() })
  .passthrough();

interface ProjectInspectorProps {
  projectId: string;
  selected: string;
  selectedItemId?: string;
  onSelect: (value: string) => void;
  onSelectItem: (itemId: string) => void;
}

export const ProjectInspector = memo(function ProjectInspector({
  projectId,
  selected,
  selectedItemId,
  onSelect,
  onSelectItem
}: ProjectInspectorProps): ReactElement {
  const snapshot = useQuery(projectSnapshotQueryOptions(projectId));
  const jobs = useQuery(projectJobsQueryOptions(projectId));
  const selectedJob = useQuery(projectJobQueryOptions(projectId, selected === "run" ? (selectedItemId ?? "") : ""));
  const evidenceValue = snapshot.data?.data.evidence;
  const artifactValue = snapshot.data?.data.artifacts;
  const evidence = useMemo(() => parseItems(evidenceValue), [evidenceValue]);
  const artifacts = useMemo(() => parseItems(artifactValue), [artifactValue]);
  return (
    <aside className={styles.inspector} data-ui="project-inspector" aria-label={ko.inspector}>
      <Tabs value={selected} onValueChange={onSelect} className={styles.tabs}>
        <TabsList aria-label={ko.inspectorView}>
          <TabsTrigger value="run">
            {ko.run} <span className={styles.tabCount}>{jobs.data?.jobs.length ?? 0}</span>
          </TabsTrigger>
          <TabsTrigger value="evidence">
            {ko.evidence} <span className={styles.tabCount}>{evidence.length}</span>
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            {ko.artifacts} <span className={styles.tabCount}>{artifacts.length}</span>
          </TabsTrigger>
        </TabsList>
        <ScrollArea className={styles.body}>
          <TabsContent value="run">
            <div className={styles.sectionHeading}>
              <div>
                <p>{ko.execution}</p>
                <h2>{ko.runHistory}</h2>
              </div>
              {jobs.isFetching ? <span role="status">{ko.updating}</span> : null}
            </div>
            {jobs.isError ? <p role="alert">{ko.runHistoryUnavailable}</p> : null}
            {selectedJob.isError ? <p role="alert">{ko.runTraceUnavailable}</p> : null}
            {selectedJob.data ? <RunTrace job={selectedJob.data} /> : null}
            {jobs.data?.jobs.map((job) => (
              <button
                type="button"
                className={styles.itemButton}
                data-selected={job.id === selectedItemId}
                aria-pressed={job.id === selectedItemId}
                key={job.id}
                onClick={() => onSelectItem(job.id)}
              >
                <div>
                  <strong>{jobKindLabel(job.kind)}</strong>
                  <Badge>{statusLabel(job.status)}</Badge>
                </div>
                <span>{stepLabel(job.currentStep)}</span>
                <small>{formatTimestamp(job.updatedAt)}</small>
              </button>
            ))}
          </TabsContent>
          <TabsContent value="evidence">
            <div className={styles.sectionHeading}>
              <div>
                <p>{ko.committedRecords}</p>
                <h2>{ko.evidence}</h2>
              </div>
            </div>
            <ItemList items={evidence} empty={ko.noCommittedEvidence} selectedItemId={selectedItemId} onSelectItem={onSelectItem} kind="evidence" />
          </TabsContent>
          <TabsContent value="artifacts">
            <div className={styles.sectionHeading}>
              <div>
                <p>{ko.promotedOutputs}</p>
                <h2>{ko.artifacts}</h2>
              </div>
            </div>
            <ItemList items={artifacts} empty={ko.noCommittedArtifacts} selectedItemId={selectedItemId} onSelectItem={onSelectItem} kind="artifact" />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
});

const RunTrace = memo(function RunTrace({ job }: { job: JobDetail }): ReactElement {
  const attemptsByDecision = useMemo(() => groupBy(job.trace.toolAttempts, (attempt) => attempt.decisionId), [job.trace.toolAttempts]);
  const codexByAttempt = useMemo(
    () => new Map(job.trace.codexCliExecutions.map((execution) => [execution.attemptId, execution] as const)),
    [job.trace.codexCliExecutions]
  );
  const outputsByAttempt = useMemo(() => groupBy(job.trace.outputs, (output) => output.attemptId), [job.trace.outputs]);
  return (
    <section className={styles.detail} aria-label={ko.selectedRunTrace}>
      <small>{ko.selectedRun}</small>
      <h3>{jobKindLabel(job.kind)}</h3>
      <p>
        {statusLabel(job.status)} · {job.traceAvailability === "available" ? ko.traceAvailable : ko.legacyRunWithoutTrace}
      </p>
      {job.blockedReason ? (
        <p role="alert">
          <strong>{ko.blockedReason}:</strong> {localizeCapabilityReason(job.blockedReason)}
        </p>
      ) : null}
      {job.failureReason ? (
        <p role="alert">
          <strong>{ko.failureReason}:</strong> {localizeCapabilityReason(job.failureReason)}
        </p>
      ) : null}
      {job.requestedCapabilities ? (
        <p>
          {ko.requestedCapabilities}: {capabilityLabel("agent")} {yesNo(job.requestedCapabilities.agent)}, {capabilityLabel("engineering")}{" "}
          {yesNo(job.requestedCapabilities.engineering)}, {capabilityLabel("search")} {yesNo(job.requestedCapabilities.search)}
        </p>
      ) : null}
      {job.trace.toolDecisions.map((decision) => {
        const attempts = attemptsByDecision.get(decision.id) ?? [];
        return (
          <article className={styles.traceItem} key={decision.id}>
            <div>
              <strong>{decision.toolName}</strong>
              <Badge>{statusLabel(decision.policyStatus)}</Badge>
            </div>
            <p>{decision.purpose || decision.expectedOutcome || ko.noDecisionSummary}</p>
            {decision.validatedInputs && Object.keys(decision.validatedInputs).length ? <ValidatedInputsDisclosure inputs={decision.validatedInputs} /> : null}
            {decision.policyReason ? (
              <p>
                {ko.policy}: {localizeCapabilityReason(decision.policyReason)}
              </p>
            ) : null}
            {attempts.map((attempt) => {
              const codex = codexByAttempt.get(attempt.id);
              const outputs = outputsByAttempt.get(attempt.id) ?? [];
              return (
                <div className={styles.attempt} key={attempt.id}>
                  <p>
                    #{attempt.ordinal} <Badge>{statusLabel(attempt.status)}</Badge>
                    {attempt.checkpointId ? <span> · {ko.checkpointed}</span> : null}
                  </p>
                  <small>
                    {ko.input} {shortHash(attempt.inputHash)}
                    {attempt.outputHash ? (
                      <span>
                        {" "}
                        · {ko.output} {shortHash(attempt.outputHash)}
                      </span>
                    ) : null}
                  </small>
                  {attempt.terminalCause || attempt.error ? (
                    <p>
                      {ko.terminalCause}: {localizeCapabilityReason(attempt.terminalCause ?? attempt.error ?? "")}
                    </p>
                  ) : null}
                  {codex ? <CodexExecution execution={codex} /> : null}
                  {outputs.map((output) => (
                    <p key={output.id}>
                      {output.outputKind} {output.outputId}: {output.promoted ? "승격됨" : "격리됨"}
                    </p>
                  ))}
                </div>
              );
            })}
          </article>
        );
      })}
      {job.trace.toolDecisions.length === 0 && job.traceAvailability === "available" ? <p>{ko.noToolDecisions}</p> : null}
    </section>
  );
});

function ValidatedInputsDisclosure({ inputs }: { inputs: Record<string, unknown> }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.inputDisclosure} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{ko.validatedInput}</summary>
      {open ? <pre className={styles.traceInputs}>{JSON.stringify(inputs, null, 2)}</pre> : null}
    </details>
  );
}

function CodexExecution({ execution }: { execution: JobDetail["trace"]["codexCliExecutions"][number] }): ReactElement {
  return (
    <dl className={styles.codexTrace} aria-label={ko.codexCliExecution}>
      <div>
        <dt>{ko.runtime}</dt>
        <dd>
          {execution.model} / {reasoningEffortLabel(execution.reasoningEffort)}
        </dd>
      </div>
      <div>
        <dt>{ko.sandbox}</dt>
        <dd>
          {execution.sandboxProfile} · 네트워크 {execution.networkPolicy === "disabled" ? ko.off : execution.networkPolicy}
        </dd>
      </div>
      <div>
        <dt>{ko.progressEvents}</dt>
        <dd>{execution.eventCount}</dd>
      </div>
      {execution.durationMs !== undefined ? (
        <div>
          <dt>{ko.duration}</dt>
          <dd>{execution.durationMs} ms</dd>
        </div>
      ) : null}
      {execution.terminationReason ? (
        <div>
          <dt>{ko.termination}</dt>
          <dd>{execution.terminationReason}</dd>
        </div>
      ) : null}
      {execution.workspaceManifestHash ? (
        <div>
          <dt>{ko.workspaceManifest}</dt>
          <dd>{shortHash(execution.workspaceManifestHash)}</dd>
        </div>
      ) : null}
      {execution.outputManifestHash ? (
        <div>
          <dt>{ko.outputManifest}</dt>
          <dd>{shortHash(execution.outputManifestHash)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function shortHash(value: string): string {
  return value.length > 16 ? value.slice(0, 12) + "…" : value;
}

function parseItems(value: unknown): z.infer<typeof InspectorItemSchema>[] {
  const parsed = z.array(InspectorItemSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
interface ItemListProps {
  items: z.infer<typeof InspectorItemSchema>[];
  empty: string;
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
  kind: "evidence" | "artifact";
}

const ItemList = memo(function ItemList({ items, empty, selectedItemId, onSelectItem, kind }: ItemListProps): ReactElement {
  const selectedItem = items.find((item) => item.id === selectedItemId);
  return (
    <div>
      {selectedItem ? (
        <section className={styles.detail} aria-label={ko.selected(kind === "evidence" ? ko.evidence : ko.artifacts)}>
          <small>{ko.selected(kind === "evidence" ? ko.evidence : ko.artifacts)}</small>
          <h3>{itemLabel(selectedItem)}</h3>
          {selectedItem.summary ? <p>{selectedItem.summary}</p> : null}
        </section>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        items.map((item, index) =>
          item.id ? (
            <button
              type="button"
              className={styles.itemButton}
              data-selected={item.id === selectedItemId}
              aria-pressed={item.id === selectedItemId}
              key={item.id}
              onClick={() => onSelectItem(item.id!)}
            >
              <strong>{itemLabel(item)}</strong>
              {item.summary ? <span>{item.summary}</span> : null}
            </button>
          ) : (
            <article className={styles.card} key={index}>
              <strong>{itemLabel(item)}</strong>
              {item.summary ? <p>{item.summary}</p> : null}
            </article>
          )
        )
      )}
    </div>
  );
});

function itemLabel(item: z.infer<typeof InspectorItemSchema>): string {
  return item.title ?? item.name ?? item.kind ?? "항목";
}

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = grouped.get(key);
    if (group) group.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

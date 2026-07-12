import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactElement } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import type { Project } from "../../../contracts/api-v2/projects.js";
import { projectApi } from "../../domain/projectApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectQueryOptions } from "../../domain/queryOptions.js";
import { SettingsLayout } from "./SettingsLayout.js";
import styles from "./Settings.module.css";
import { capabilityLabel, ko, localizeError } from "../../platform/i18n.js";

export function ProjectBriefPage(): ReactElement {
  const { projectId = "" } = useParams();
  const project = useQuery(projectQueryOptions(projectId));
  return (
    <SettingsLayout projectId={projectId} title={ko.researchBrief} description={ko.researchBriefDescription}>
      {project.data ? <BriefForm key={project.data.execution.revision} project={project.data} /> : <p>{ko.loadingProject}</p>}
    </SettingsLayout>
  );
}

function BriefForm({ project }: { project: Project }): ReactElement {
  const client = useQueryClient();
  const [input, setInput] = useState(project.input);
  const save = useMutation({
    mutationFn: () => projectApi.update({ projectId: project.id, expectedRevision: project.execution.revision, input }),
    onSuccess: (value) => client.setQueryData(shellQueryKeys.projects.detail(project.id), value)
  });
  return (
    <form
      className={styles.form}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field label={ko.topic}>
        <Input required value={input.topic} onChange={(event) => setInput({ ...input, topic: event.target.value })} />
      </Field>
      <Field label={ko.goal}>
        <Textarea required value={input.goal} onChange={(event) => setInput({ ...input, goal: event.target.value })} />
      </Field>
      <Field label={ko.scope}>
        <Textarea required value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} />
      </Field>
      <Field label={ko.budget}>
        <Input required value={input.budget} onChange={(event) => setInput({ ...input, budget: event.target.value })} />
      </Field>
      <Save pending={save.isPending} saved={save.isSuccess} error={save.error} />
    </form>
  );
}

export function RunPolicyPage(): ReactElement {
  const { projectId = "" } = useParams();
  const project = useQuery(projectQueryOptions(projectId));
  return (
    <SettingsLayout projectId={projectId} title={ko.runPolicy} description={ko.runPolicyDescription}>
      {project.data ? <RunPolicyForm key={project.data.execution.revision} project={project.data} /> : <p>{ko.loadingProject}</p>}
    </SettingsLayout>
  );
}

function RunPolicyForm({ project }: { project: Project }): ReactElement {
  const client = useQueryClient();
  const [capabilities, setCapabilities] = useState(project.capabilities);
  const save = useMutation({
    mutationFn: () => projectApi.update({ projectId: project.id, expectedRevision: project.execution.revision, input: {}, capabilities }),
    onSuccess: (value) => client.setQueryData(shellQueryKeys.projects.detail(project.id), value)
  });
  return (
    <form
      className={styles.form}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {(["agent", "engineering", "search"] as const).map((name) => (
        <Label className={styles.switchRow} key={name}>
          <span>
            <strong>{capabilityLabel(name)}</strong>
            <small>{capabilityHelp(name)}</small>
          </span>
          <Switch checked={capabilities[name]} onCheckedChange={(checked) => setCapabilities({ ...capabilities, [name]: checked })} />
        </Label>
      ))}
      <Save pending={save.isPending} saved={save.isSuccess} error={save.error} />
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <Label className={styles.field}>
      <span>{label}</span>
      {children}
    </Label>
  );
}
function Save({ pending, saved, error }: { pending: boolean; saved: boolean; error: Error | null }): ReactElement {
  return (
    <div className={styles.actions}>
      {error ? (
        <p className={styles.actionError} role="alert">
          {localizeError(error)}
        </p>
      ) : null}
      {saved ? <span>{ko.saved}</span> : null}
      <Button type="submit" disabled={pending}>
        {pending ? ko.saving : ko.save}
      </Button>
    </div>
  );
}
function capabilityHelp(name: "agent" | "engineering" | "search"): string {
  if (name === "agent") return ko.agentHelp;
  if (name === "engineering") return ko.engineeringHelp;
  return ko.searchHelp;
}

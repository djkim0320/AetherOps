import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { projectApi } from "../../domain/projectApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectsListQueryOptions } from "../../domain/queryOptions.js";
import styles from "./ProjectsPage.module.css";

export function ProjectsPage(): ReactElement {
  const projects = useQuery(projectsListQueryOptions());
  return (
    <section className={styles.page} data-ui="projects-page" aria-labelledby="projects-title">
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Workspace</p>
          <h1 id="projects-title">Projects</h1>
          <p>Select a project to continue in chat.</p>
        </div>
        <Button asChild>
          <Link to="/projects/new">
            <Plus aria-hidden="true" />
            New project
          </Link>
        </Button>
      </header>
      {projects.isPending ? <p>Loading projects…</p> : null}
      {projects.isError ? (
        <p role="alert" className={styles.error}>
          Projects could not be loaded. Use refresh to retry.
        </p>
      ) : null}
      {projects.data?.length === 0 ? (
        <div className={styles.empty}>
          <h2>No projects yet</h2>
          <p>Create a research brief to begin.</p>
        </div>
      ) : null}
      <div className={styles.grid}>
        {projects.data?.map((project) => (
          <Card key={project.id}>
            <CardHeader>
              <CardTitle>{project.input.topic}</CardTitle>
              <Badge variant={statusVariant(project.execution.status)}>{project.execution.status}</Badge>
            </CardHeader>
            <CardContent>
              <p>{project.input.goal}</p>
              <Link className={styles.open} to={`/projects/${encodeURIComponent(project.id)}/chats/new`}>
                Open chat <ArrowRight aria-hidden="true" />
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function NewProjectPage(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [input, setInput] = useState({ topic: "", goal: "", scope: "", budget: "" });
  const createProject = useMutation({
    mutationFn: projectApi.create,
    onSuccess: (project) => {
      queryClient.setQueryData(shellQueryKeys.projects.detail(project.id), project);
      void queryClient.invalidateQueries({ queryKey: shellQueryKeys.projects.all() });
      navigate(`/projects/${encodeURIComponent(project.id)}/chats/new`);
    }
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    createProject.mutate({ input });
  }
  return (
    <section className={styles.formPage} data-ui="new-project-page" aria-labelledby="new-project-title">
      <header>
        <p className={styles.eyebrow}>Project</p>
        <h1 id="new-project-title">Create a research project</h1>
        <p>Define the durable brief used by chat and research runs.</p>
      </header>
      <form className={styles.form} onSubmit={submit}>
        <Field label="Topic">
          <Input required maxLength={1000} value={input.topic} onChange={(event) => setInput({ ...input, topic: event.target.value })} />
        </Field>
        <Field label="Goal">
          <Textarea required maxLength={4000} value={input.goal} onChange={(event) => setInput({ ...input, goal: event.target.value })} />
        </Field>
        <Field label="Scope">
          <Textarea required maxLength={4000} value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} />
        </Field>
        <Field label="Budget and constraints">
          <Input required maxLength={1000} value={input.budget} onChange={(event) => setInput({ ...input, budget: event.target.value })} />
        </Field>
        {createProject.error ? (
          <p role="alert" className={styles.error}>
            {createProject.error.message}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/projects")}>
            Cancel
          </Button>
          <Button type="submit" disabled={createProject.isPending}>
            {createProject.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </section>
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
function statusVariant(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (["blocked", "failed", "interrupted"].includes(status)) return "danger";
  if (status !== "idle") return "warning";
  return "neutral";
}

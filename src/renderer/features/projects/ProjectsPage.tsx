import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Clock3, FolderKanban, Plus } from "lucide-react";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { projectApi } from "../../domain/projectApi.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { projectsListQueryOptions } from "../../domain/projectListQuery.js";
import styles from "./ProjectsPage.module.css";
import { ko, formatRelativeTime, localizeError, statusLabel } from "../../platform/i18n.js";

export function ProjectsPage(): ReactElement {
  const projects = useQuery(projectsListQueryOptions());
  return (
    <section className={styles.page} data-ui="projects-page" aria-labelledby="projects-title">
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>{ko.researchWorkspace}</p>
          <h1 id="projects-title">{ko.pickUpWhereLeftOff}</h1>
          <p>{ko.continueProject}</p>
        </div>
        <Button asChild>
          <Link to="/projects/new">
            <Plus aria-hidden="true" />
            {ko.newProject}
          </Link>
        </Button>
      </header>
      {projects.isPending ? <p>{ko.loadingProjects}</p> : null}
      {projects.isError ? (
        <p role="alert" className={styles.error}>
          {ko.projectsUnavailable} 새로고침 후 다시 시도하세요.
        </p>
      ) : null}
      {projects.data?.length === 0 ? (
        <div className={styles.empty}>
          <h2>{ko.noProjects}</h2>
          <p>{ko.createResearchBrief}</p>
        </div>
      ) : null}
      {projects.data?.length ? (
        <div className={styles.listHeader} aria-hidden="true">
          <span>{ko.recentProjects}</span>
          <span>{projects.data.length}</span>
        </div>
      ) : null}
      <ul className={styles.projectList}>
        {projects.data?.map((project) => (
          <li key={project.id} className={styles.projectItem}>
            <Link className={styles.projectRow} data-ui="project-row" to={`/projects/${encodeURIComponent(project.id)}/chats/new`}>
              <span className={styles.projectIcon} aria-hidden="true">
                <FolderKanban />
              </span>
              <span className={styles.projectCopy}>
                <strong>{project.input.topic}</strong>
                <span>{project.input.goal}</span>
              </span>
              <span className={styles.projectMeta}>
                <Badge variant={statusVariant(project.execution.status)}>{statusLabel(project.execution.status)}</Badge>
                <span className={styles.updated}>
                  <Clock3 aria-hidden="true" />
                  {formatRelativeTime(project.updatedAt)}
                </span>
              </span>
              <ArrowRight className={styles.rowArrow} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
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
        <p className={styles.eyebrow}>{ko.project}</p>
        <h1 id="new-project-title">{ko.createResearchProject}</h1>
        <p>{ko.newProjectDescription}</p>
      </header>
      <form className={styles.form} onSubmit={submit}>
        <Field label={ko.topic}>
          <Input required maxLength={1000} value={input.topic} onChange={(event) => setInput({ ...input, topic: event.target.value })} />
        </Field>
        <Field label={ko.goal}>
          <Textarea required maxLength={4000} value={input.goal} onChange={(event) => setInput({ ...input, goal: event.target.value })} />
        </Field>
        <Field label={ko.scope}>
          <Textarea required maxLength={4000} value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} />
        </Field>
        <Field label={ko.budgetAndConstraints}>
          <Input required maxLength={1000} value={input.budget} onChange={(event) => setInput({ ...input, budget: event.target.value })} />
        </Field>
        {createProject.error ? (
          <p role="alert" className={styles.error}>
            {localizeError(createProject.error)}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/projects")}>
            {ko.cancel}
          </Button>
          <Button type="submit" disabled={createProject.isPending}>
            {createProject.isPending ? ko.creating : ko.createProject}
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

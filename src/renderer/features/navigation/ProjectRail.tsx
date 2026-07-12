import { useQuery } from "@tanstack/react-query";
import { MessageSquarePlus, Plus, Search, Settings } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { OrbitMark } from "../../components/ui/orbit-mark.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { projectsListQueryOptions } from "../../domain/projectListQuery.js";
import styles from "./ProjectRail.module.css";
import { ko, statusLabel } from "../../platform/i18n.js";

export function ProjectRail({ collapsed, projectId }: { collapsed: boolean; projectId?: string }): ReactElement {
  const navigate = useNavigate();
  const projects = useQuery(projectsListQueryOptions());
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return [...(projects.data ?? [])]
      .filter((project) => !needle || `${project.input.topic} ${project.input.goal}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [projects.data, search]);

  return (
    <aside className={styles.rail} data-ui="project-rail" data-collapsed={collapsed} aria-label={ko.projects}>
      <Link to="/projects" className={styles.brand} aria-label="AetherOps 프로젝트">
        <OrbitMark decorative />
        <span hidden={collapsed}>AetherOps</span>
      </Link>
      <Link to={projectId ? `/projects/${encodeURIComponent(projectId)}/chats/new` : "/projects/new"} className={styles.newChat}>
        <MessageSquarePlus aria-hidden="true" />
        <span hidden={collapsed}>{ko.newTask}</span>
      </Link>
      {!collapsed ? (
        <label className={styles.search}>
          <Search aria-hidden="true" />
          <span className="srOnly">{ko.projectSearch}</span>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={ko.taskSearch} />
        </label>
      ) : null}
      <ScrollArea className={styles.list}>
        {!collapsed ? <p className={styles.sectionLabel}>{ko.recentProjects}</p> : null}
        {projects.isPending ? <p className={styles.status}>{ko.loadingProjects}</p> : null}
        {projects.isError ? (
          <p className={styles.error} role="alert">
            {ko.projectsUnavailable}
          </p>
        ) : null}
        {visible.map((project) => (
          <Link
            key={project.id}
            to={`/projects/${encodeURIComponent(project.id)}/chats/new`}
            className={`${styles.project}${project.id === projectId ? ` ${styles.active}` : ""}`}
            title={collapsed ? project.input.topic : undefined}
            aria-current={project.id === projectId ? "page" : undefined}
          >
            <span className={styles.projectMark} data-status={project.execution.status} aria-hidden="true">
              {project.input.topic.slice(0, 1).toLocaleUpperCase()}
            </span>
            <span className={styles.projectCopy} hidden={collapsed}>
              <span className={styles.projectTitle}>{project.input.topic}</span>
              <span className={styles.projectMeta}>{executionLabel(project.execution.status)}</span>
            </span>
          </Link>
        ))}
        {!projects.isPending && !projects.isError && visible.length === 0 && !collapsed ? (
          <p className={styles.status}>{search.trim() ? ko.noMatchingTasks : ko.createProjectToBegin}</p>
        ) : null}
      </ScrollArea>
      <nav className={styles.footer} aria-label={ko.settings}>
        <NavLink to="/settings/codex" className={styles.project}>
          <Settings aria-hidden="true" />
          <span hidden={collapsed}>{ko.settings}</span>
        </NavLink>
        <Button variant="ghost" size="sm" aria-label={ko.createProject} onClick={() => navigate("/projects/new")}>
          <Plus aria-hidden="true" />
          <span hidden={collapsed}>{ko.project}</span>
        </Button>
      </nav>
    </aside>
  );
}

function executionLabel(status: string): string {
  return statusLabel(status);
}

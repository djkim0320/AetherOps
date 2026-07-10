import { FolderKanban, MessageSquarePlus, Plus, Search, Settings } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactElement } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { OrbitMark } from "../../components/ui/orbit-mark.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { projectsListQueryOptions } from "../../domain/queryOptions.js";
import styles from "./ProjectRail.module.css";

export function ProjectRail({ collapsed, projectId }: { collapsed: boolean; projectId?: string }): ReactElement {
  const navigate = useNavigate();
  const projects = useQuery(projectsListQueryOptions());
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (projects.data ?? []).filter((project) => !needle || `${project.input.topic} ${project.input.goal}`.toLocaleLowerCase().includes(needle));
  }, [projects.data, search]);

  return (
    <aside className={styles.rail} data-ui="project-rail" aria-label="Projects">
      <Link to="/projects" className={styles.brand} aria-label="AetherOps projects">
        <OrbitMark decorative />
        <span hidden={collapsed}>AetherOps</span>
      </Link>
      <Link to={projectId ? `/projects/${encodeURIComponent(projectId)}/chats/new` : "/projects/new"} className={styles.newChat}>
        <MessageSquarePlus aria-hidden="true" />
        <span hidden={collapsed}>New chat</span>
      </Link>
      {!collapsed ? (
        <label className={styles.search}>
          <Search aria-hidden="true" />
          <span className="srOnly">Search projects</span>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" />
        </label>
      ) : null}
      <ScrollArea className={styles.list}>
        {projects.isPending ? <p className={styles.status}>Loading…</p> : null}
        {projects.isError ? (
          <p className={styles.error} role="alert">
            Projects unavailable.
          </p>
        ) : null}
        {visible.map((project) => (
          <NavLink
            key={project.id}
            to={`/projects/${encodeURIComponent(project.id)}/chats/new`}
            className={({ isActive }) => `${styles.project}${isActive ? ` ${styles.active}` : ""}`}
            title={collapsed ? project.input.topic : undefined}
          >
            <FolderKanban aria-hidden="true" />
            <span hidden={collapsed}>{project.input.topic}</span>
          </NavLink>
        ))}
      </ScrollArea>
      <nav className={styles.footer} aria-label="Settings">
        <NavLink to="/settings/codex" className={styles.project}>
          <Settings aria-hidden="true" />
          <span hidden={collapsed}>Settings</span>
        </NavLink>
        <Button variant="ghost" size="sm" aria-label="Create project" onClick={() => navigate("/projects/new")}>
          <Plus aria-hidden="true" />
          <span hidden={collapsed}>Project</span>
        </Button>
      </nav>
    </aside>
  );
}

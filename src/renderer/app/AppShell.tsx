import { PanelRightClose, PanelRightOpen, SidebarClose, SidebarOpen } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Outlet, useLocation, useMatches, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button.js";
import { ProjectRail } from "../features/navigation/public.js";
import { ProjectInspector, RunBar } from "../features/run/public.js";
import { useShellPreferences } from "./ShellPreferencesProvider.js";
import { useTheme } from "./ThemeProvider.js";
import { ProjectEventsBridge } from "./ProjectEventsBridge.js";
import styles from "./AppShell.module.css";

export function AppShell(): ReactElement {
  const matches = useMatches();
  const projectId = [...matches]
    .reverse()
    .map((match) => match.params.projectId)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { railCollapsed, toggleRail } = useShellPreferences();
  const { theme, toggleTheme } = useTheme();
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const inspector = searchParams.get("inspector") ?? "run";
  const inspectorItemId = searchParams.get("item") ?? undefined;

  function setInspector(value: string): void {
    setSearchParams((current) => {
      current.set("inspector", value);
      current.delete("item");
      return current;
    });
  }

  function setInspectorItem(itemId: string): void {
    setSearchParams((current) => {
      current.set("item", itemId);
      return current;
    });
  }

  return (
    <div className={styles.shell} data-ui="app-shell" data-rail-collapsed={railCollapsed} data-inspector-visible={inspectorVisible}>
      {projectId ? <ProjectEventsBridge projectId={projectId} /> : null}
      <ProjectRail collapsed={railCollapsed} projectId={projectId} />
      <main className={styles.workspace} data-ui="workspace">
        <header className={styles.header}>
          <Button variant="ghost" size="sm" onClick={toggleRail} aria-label={railCollapsed ? "Expand project rail" : "Collapse project rail"}>
            {railCollapsed ? <SidebarOpen aria-hidden="true" /> : <SidebarClose aria-hidden="true" />}
          </Button>
          <div className={styles.breadcrumb} aria-label="Breadcrumb">
            <span>AetherOps</span>
            <span aria-hidden="true">/</span>
            <strong>{routeTitle(location.pathname)}</strong>
          </div>
          <div className={styles.headerActions}>
            <Button variant="ghost" size="sm" onClick={toggleTheme}>
              {theme === "dark" ? "Light" : "Dark"}
            </Button>
            {projectId ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInspectorVisible((value) => !value)}
                aria-label={inspectorVisible ? "Hide inspector" : "Show inspector"}
              >
                {inspectorVisible ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
              </Button>
            ) : null}
          </div>
        </header>
        {projectId ? <RunBar projectId={projectId} /> : null}
        <div className={styles.content}>
          <Outlet />
        </div>
      </main>
      {projectId && inspectorVisible ? (
        <ProjectInspector projectId={projectId} selected={inspector} selectedItemId={inspectorItemId} onSelect={setInspector} onSelectItem={setInspectorItem} />
      ) : null}
    </div>
  );
}

function routeTitle(pathname: string): string {
  if (pathname === "/projects") return "Projects";
  if (pathname === "/projects/new") return "New project";
  if (pathname.startsWith("/settings/")) return "Settings";
  if (pathname.includes("/settings/brief")) return "Research brief";
  if (pathname.includes("/settings/run-policy")) return "Run policy";
  return "Chat";
}

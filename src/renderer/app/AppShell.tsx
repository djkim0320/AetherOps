import { lazy, Suspense, useCallback, useMemo, useState, type ReactElement } from "react";
import { Outlet, useLocation, useMatches, useSearchParams } from "react-router-dom";
import { ProjectRail } from "../features/navigation/public.js";
import { useShellPreferences } from "./ShellPreferencesProvider.js";
import { useTheme } from "./ThemeProvider.js";
import { ProjectEventsBridge } from "./ProjectEventsBridge.js";
import { WorkspaceHeader } from "./WorkspaceHeader.js";
import styles from "./AppShell.module.css";
import { ko } from "../platform/i18n.js";

const LazyRunBar = lazy(() => import("../features/run/public.js").then((module) => ({ default: module.RunBar })));
const LazyProjectInspector = lazy(() => import("../features/run/public.js").then((module) => ({ default: module.ProjectInspector })));

export function AppShell(): ReactElement {
  const matches = useMatches();
  const projectId = useMemo(
    () =>
      [...matches]
        .reverse()
        .map((match) => match.params.projectId)
        .find((value): value is string => typeof value === "string" && value.length > 0),
    [matches]
  );
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { railCollapsed, toggleRail } = useShellPreferences();
  const { theme, toggleTheme } = useTheme();
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const inspector = searchParams.get("inspector") ?? "run";
  const inspectorItemId = searchParams.get("item") ?? undefined;

  const setInspector = useCallback(
    (value: string): void => {
      setSearchParams((current) => {
        current.set("inspector", value);
        current.delete("item");
        return current;
      });
    },
    [setSearchParams]
  );

  const setInspectorItem = useCallback(
    (itemId: string): void => {
      setSearchParams((current) => {
        current.set("item", itemId);
        return current;
      });
    },
    [setSearchParams]
  );
  const toggleInspector = useCallback(() => setInspectorVisible((value) => !value), []);

  return (
    <div className={styles.shell} data-ui="app-shell" data-rail-collapsed={railCollapsed} data-inspector-visible={inspectorVisible}>
      {projectId ? <ProjectEventsBridge projectId={projectId} /> : null}
      <ProjectRail collapsed={railCollapsed} projectId={projectId} />
      <main className={styles.workspace} data-ui="workspace">
        <WorkspaceHeader
          context={projectId ? ko.projectWorkspace : ko.brand}
          title={routeTitle(location.pathname)}
          railCollapsed={railCollapsed}
          inspectorAvailable={Boolean(projectId)}
          inspectorVisible={inspectorVisible}
          theme={theme}
          onToggleRail={toggleRail}
          onToggleTheme={toggleTheme}
          onToggleInspector={toggleInspector}
        />
        {projectId ? (
          <Suspense fallback={<div className={styles.runBarFallback} aria-hidden="true" />}>
            <LazyRunBar projectId={projectId} />
          </Suspense>
        ) : null}
        <div className={styles.content}>
          <Outlet />
        </div>
      </main>
      {projectId && inspectorVisible ? (
        <Suspense fallback={<aside className={styles.inspectorFallback} aria-hidden="true" />}>
          <LazyProjectInspector
            projectId={projectId}
            selected={inspector}
            selectedItemId={inspectorItemId}
            onSelect={setInspector}
            onSelectItem={setInspectorItem}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function routeTitle(pathname: string): string {
  if (pathname === "/projects") return ko.projects;
  if (pathname === "/projects/new") return ko.newProject;
  if (pathname.startsWith("/settings/")) return ko.settings;
  if (pathname.includes("/settings/brief")) return ko.researchBrief;
  if (pathname.includes("/settings/run-policy")) return ko.runPolicy;
  return ko.chat;
}

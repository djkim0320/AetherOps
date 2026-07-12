import { Moon, PanelRightClose, PanelRightOpen, SidebarClose, SidebarOpen, Sun } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.js";
import { ko } from "../platform/i18n.js";
import styles from "./WorkspaceHeader.module.css";

interface WorkspaceHeaderProps {
  context: string;
  inspectorAvailable: boolean;
  inspectorVisible: boolean;
  railCollapsed: boolean;
  theme: "dark" | "light";
  title: string;
  onToggleInspector: () => void;
  onToggleRail: () => void;
  onToggleTheme: () => void;
}

export function WorkspaceHeader({
  context,
  inspectorAvailable,
  inspectorVisible,
  railCollapsed,
  theme,
  title,
  onToggleInspector,
  onToggleRail,
  onToggleTheme
}: WorkspaceHeaderProps): ReactElement {
  return (
    <header className={styles.header} data-ui="workspace-header">
      <Button className={styles.iconButton} variant="ghost" size="icon" onClick={onToggleRail} aria-label={railCollapsed ? ko.expandRail : ko.collapseRail}>
        {railCollapsed ? <SidebarOpen aria-hidden="true" /> : <SidebarClose aria-hidden="true" />}
      </Button>
      <div className={styles.identity}>
        <span className={styles.context}>{context}</span>
        <span className={styles.title}>{title}</span>
      </div>
      <div className={styles.actions}>
        <Button
          className={styles.iconButton}
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? ko.useLightTheme : ko.useDarkTheme}
        >
          {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button>
        {inspectorAvailable ? (
          <Button
            className={styles.iconButton}
            variant="ghost"
            size="icon"
            onClick={onToggleInspector}
            aria-label={inspectorVisible ? ko.hideInspector : ko.showInspector}
            aria-pressed={inspectorVisible}
          >
            {inspectorVisible ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
          </Button>
        ) : null}
      </div>
    </header>
  );
}

import { type ReactElement, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import styles from "./Settings.module.css";
import { ko } from "../../platform/i18n.js";

export function SettingsLayout({
  title,
  description,
  projectId,
  children
}: {
  title: string;
  description: string;
  projectId?: string;
  children: ReactNode;
}): ReactElement {
  const links = projectId
    ? [
        [ko.researchBrief, `/projects/${projectId}/settings/brief`],
        [ko.runPolicy, `/projects/${projectId}/settings/run-policy`]
      ]
    : [
        [ko.codex, "/settings/codex"],
        [ko.connections, "/settings/connections"],
        [ko.tools, "/settings/tools"],
        [ko.appearance, "/settings/appearance"]
      ];
  return (
    <section className={styles.page} data-ui="settings-page">
      <header>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <nav className={styles.nav}>
        {links.map(([label, to]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? styles.active : undefined)}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div className={styles.panel}>{children}</div>
    </section>
  );
}

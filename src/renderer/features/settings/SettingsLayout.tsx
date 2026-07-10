import { type ReactElement, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import styles from "./Settings.module.css";

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
        ["Brief", `/projects/${projectId}/settings/brief`],
        ["Run policy", `/projects/${projectId}/settings/run-policy`]
      ]
    : [
        ["Codex", "/settings/codex"],
        ["Connections", "/settings/connections"],
        ["Tools", "/settings/tools"],
        ["Appearance", "/settings/appearance"]
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

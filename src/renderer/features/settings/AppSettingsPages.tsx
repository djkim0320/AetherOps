import { useQuery } from "@tanstack/react-query";
import { type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Label } from "../../components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";
import { llmStatusQueryOptions, settingsQueryOptions, toolsDiagnosticsQueryOptions } from "../../domain/queryOptions.js";
import { useTheme } from "../../app/ThemeProvider.js";
import { SettingsLayout } from "./SettingsLayout.js";
import { CodexSettingsForm } from "./CodexSettingsForm.js";
import styles from "./Settings.module.css";
import { categoryLabel, ko, localizeError, statusLabel, toolStatusLabel } from "../../platform/i18n.js";

export function CodexSettingsPage(): ReactElement {
  const settings = useQuery(settingsQueryOptions());
  const status = useQuery(llmStatusQueryOptions());
  return (
    <SettingsLayout title="Codex" description={ko.codexOnlyDescription}>
      <div className={styles.status}>
        <Badge variant={status.data?.available ? "success" : "danger"}>{status.data?.status ? statusLabel(status.data.status) : ko.statusChecking}</Badge>
        <Badge variant={status.data?.catalog === "supported" ? "success" : status.data ? "danger" : "neutral"}>
          {ko.catalog}: {status.data?.catalog ? statusLabel(status.data.catalog) : ko.statusChecking}
        </Badge>
        <Badge variant={status.data?.access === "available" ? "success" : status.data?.access === "unavailable" ? "danger" : "warning"}>
          {ko.access}: {status.data?.access ? statusLabel(status.data.access) : ko.statusChecking}
        </Badge>
        <span>{status.data?.message ? localizeError(status.data.message) : null}</span>
      </div>
      {settings.data ? <CodexSettingsForm key={settings.data.updatedAt} settings={settings.data} /> : <p>{ko.loadingSettings}</p>}
    </SettingsLayout>
  );
}

export function ConnectionsPage(): ReactElement {
  const settings = useQuery(settingsQueryOptions());
  return (
    <SettingsLayout title={ko.connections} description={ko.connectionsDescription}>
      <div className={styles.stack}>
        {settings.data ? (
          <>
            <Connection
              title={ko.embedding}
              detail={`${settings.data.embedding.provider} · ${settings.data.embedding.model ?? ko.noModel}`}
              configured={settings.data.embedding.apiKeyConfigured}
            />
            <Connection title={ko.webSearch} detail={settings.data.search.provider} configured={settings.data.search.apiKeyConfigured} />
          </>
        ) : (
          <p>{ko.loadingConnections}</p>
        )}
      </div>
    </SettingsLayout>
  );
}

function Connection({ title, detail, configured }: { title: string; detail: string; configured: boolean }): ReactElement {
  return (
    <section>
      <h2>{title}</h2>
      <p>{detail}</p>
      <Badge variant={configured ? "success" : "warning"}>{configured ? ko.keyConfigured : ko.keyRequired}</Badge>
    </section>
  );
}

export function ToolsPage(): ReactElement {
  const diagnostics = useQuery(toolsDiagnosticsQueryOptions());
  return (
    <SettingsLayout title={ko.tools} description={ko.toolsDescription}>
      <div className={styles.stack}>
        {diagnostics.data?.tools.map((tool) => (
          <section key={tool.name} className={styles.tool}>
            <div>
              <h2>{tool.name}</h2>
              <small>{categoryLabel(tool.category)}</small>
            </div>
            <Badge variant={tool.status === "ready" ? "success" : tool.status === "blocked" ? "warning" : "danger"}>{toolStatusLabel(tool.status)}</Badge>
            {tool.reason ? <p className={styles.toolReason}>{localizeError(tool.reason)}</p> : null}
          </section>
        ))}
        {diagnostics.isError ? <p role="alert">{ko.diagnosticsUnavailable}</p> : null}
      </div>
    </SettingsLayout>
  );
}

export function AppearancePage(): ReactElement {
  const { theme, setTheme } = useTheme();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <SettingsLayout title={ko.appearance} description={ko.appearanceDescription}>
      <div className={styles.form}>
        <Label className={styles.field}>
          <span>{ko.theme}</span>
          <Select value={theme} onValueChange={(value) => setTheme(value === "light" ? "light" : "dark")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">{ko.dark}</SelectItem>
              <SelectItem value="light">{ko.light}</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        <Label className={styles.switchRow}>
          <span>
            <strong>{ko.reducedMotion}</strong>
            <small>{ko.followsSystemPreference}</small>
          </span>
          <Switch checked={reducedMotion} disabled />
        </Label>
      </div>
    </SettingsLayout>
  );
}

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

export function CodexSettingsPage(): ReactElement {
  const settings = useQuery(settingsQueryOptions());
  const status = useQuery(llmStatusQueryOptions());
  return (
    <SettingsLayout title="Codex" description="AetherOps uses Codex OAuth as its only orchestrator LLM.">
      <div className={styles.status}>
        <Badge variant={status.data?.available ? "success" : "danger"}>{status.data?.status ?? "checking"}</Badge>
        <Badge variant={status.data?.catalog === "supported" ? "success" : status.data ? "danger" : "neutral"}>
          Catalog: {status.data?.catalog ?? "checking"}
        </Badge>
        <Badge variant={status.data?.access === "available" ? "success" : status.data?.access === "unavailable" ? "danger" : "warning"}>
          Access: {status.data?.access?.replace("_", " ") ?? "checking"}
        </Badge>
        <span>{status.data?.message}</span>
      </div>
      {settings.data ? <CodexSettingsForm key={settings.data.updatedAt} settings={settings.data} /> : <p>Loading settings…</p>}
    </SettingsLayout>
  );
}

export function ConnectionsPage(): ReactElement {
  const settings = useQuery(settingsQueryOptions());
  return (
    <SettingsLayout title="Connections" description="Embedding and search providers remain independent from Codex.">
      <div className={styles.stack}>
        {settings.data ? (
          <>
            <Connection
              title="Embedding"
              detail={`${settings.data.embedding.provider} · ${settings.data.embedding.model ?? "No model"}`}
              configured={settings.data.embedding.apiKeyConfigured}
            />
            <Connection title="Web search" detail={settings.data.search.provider} configured={settings.data.search.apiKeyConfigured} />
          </>
        ) : (
          <p>Loading connections…</p>
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
      <Badge variant={configured ? "success" : "warning"}>{configured ? "Key configured" : "Key required"}</Badge>
    </section>
  );
}

export function ToolsPage(): ReactElement {
  const diagnostics = useQuery(toolsDiagnosticsQueryOptions());
  return (
    <SettingsLayout title="Tools" description="Readiness reported by the runtime; unavailable tools do not silently fall back.">
      <div className={styles.stack}>
        {diagnostics.data?.tools.map((tool) => (
          <section key={tool.name} className={styles.tool}>
            <div>
              <h2>{tool.name}</h2>
              <small>{tool.category}</small>
            </div>
            <Badge variant={tool.status === "ready" ? "success" : tool.status === "blocked" ? "warning" : "danger"}>{tool.status}</Badge>
            {tool.reason ? <p className={styles.toolReason}>{tool.reason}</p> : null}
          </section>
        ))}
        {diagnostics.isError ? <p role="alert">Diagnostics unavailable.</p> : null}
      </div>
    </SettingsLayout>
  );
}

export function AppearancePage(): ReactElement {
  const { theme, setTheme } = useTheme();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <SettingsLayout title="Appearance" description="Theme preference is stored only on this device.">
      <div className={styles.form}>
        <Label className={styles.field}>
          <span>Theme</span>
          <Select value={theme} onValueChange={(value) => setTheme(value === "light" ? "light" : "dark")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        <Label className={styles.switchRow}>
          <span>
            <strong>Reduced motion</strong>
            <small>Follows your operating system preference.</small>
          </span>
          <Switch checked={reducedMotion} disabled />
        </Label>
      </div>
    </SettingsLayout>
  );
}

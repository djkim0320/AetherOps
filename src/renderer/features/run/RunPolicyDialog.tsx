import type { CapabilitySet, JobToolPolicy } from "../../../contracts/api-v2/index.js";
import { useState, type ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import styles from "./RunBar.module.css";
import { ko } from "../../platform/i18n.js";

type SourceMode = JobToolPolicy["sourceAccess"]["mode"];

export interface ConfirmedRunPolicy {
  requestedCapabilities: CapabilitySet;
  toolPolicy: JobToolPolicy;
}

export function RunPolicyDialog({
  open,
  action,
  maximum,
  onOpenChange,
  onConfirm
}: {
  open: boolean;
  action: "start" | "resume";
  maximum: CapabilitySet;
  onOpenChange(open: boolean): void;
  onConfirm(policy: ConfirmedRunPolicy): void;
}): ReactElement {
  const [requested, setRequested] = useState<CapabilitySet>(maximum);
  const [sourceMode, setSourceMode] = useState<SourceMode>(maximum.search ? "discovery" : "offline");
  const [sourceValues, setSourceValues] = useState("");
  const [allowCodexCli, setAllowCodexCli] = useState(false);
  const values = sourceValues
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
  const error = validationError({ requested, maximum, sourceMode, values, allowCodexCli });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.policyDialog}>
        <DialogTitle>{action === "start" ? ko.startResearchRun : ko.resumeResearchRun}</DialogTitle>
        <DialogDescription>{ko.policyDescription}</DialogDescription>
        <div className={styles.policyRows}>
          {(["agent", "engineering", "search"] as const).map((capability) => (
            <Label className={styles.policyRow} key={capability}>
              <span>
                <strong>{capability === "agent" ? ko.agent : capability === "engineering" ? ko.engineering : ko.search}</strong>
                <small>{capability === "agent" ? "Codex 오케스트레이션에 필요" : `프로젝트 최대 권한: ${maximum[capability] ? ko.on : ko.off}`}</small>
              </span>
              <Switch
                checked={requested[capability]}
                disabled={capability === "agent" || !maximum[capability]}
                onCheckedChange={(checked) => {
                  const next = { ...requested, [capability]: checked };
                  if (capability === "search" && !checked) setSourceMode("offline");
                  if (capability === "engineering" && !checked) setAllowCodexCli(false);
                  setRequested(next);
                }}
              />
            </Label>
          ))}
          <Label className={styles.policyField}>
            <span>{ko.sourceAccess}</span>
            <Select value={sourceMode} onValueChange={(value) => setSourceMode(value as SourceMode)} disabled={!requested.search}>
              <SelectTrigger aria-label={ko.sourceAccessMode}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="offline">{ko.offline}</SelectItem>
                <SelectItem value="allowlist">{ko.exactUrlAllowlist}</SelectItem>
                <SelectItem value="discovery">{ko.publicDiscovery}</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {sourceMode !== "offline" ? (
            <Label className={styles.policyField}>
              <span>{sourceMode === "allowlist" ? ko.allowedUrls : ko.allowedDomains}</span>
              <Textarea value={sourceValues} onChange={(event) => setSourceValues(event.target.value)} rows={3} placeholder={ko.oneValuePerLine} />
            </Label>
          ) : null}
          <Label className={styles.policyRow}>
            <span>
              <strong>{ko.codexWorkspaceExecution}</strong>
              <small>{ko.codexWorkspaceDescription}</small>
            </span>
            <Switch
              aria-label={ko.allowCodexWorkspaceExecution}
              checked={allowCodexCli}
              disabled={!requested.agent || !requested.engineering}
              onCheckedChange={setAllowCodexCli}
            />
          </Label>
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={styles.policyActions}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {ko.cancel}
          </Button>
          <Button
            disabled={Boolean(error)}
            onClick={() => {
              onConfirm({ requestedCapabilities: requested, toolPolicy: buildToolPolicy(sourceMode, values, allowCodexCli) });
              onOpenChange(false);
            }}
          >
            {action === "start" ? ko.start : ko.resume}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function buildToolPolicy(mode: SourceMode, values: string[], allowCodexCli: boolean): JobToolPolicy {
  if (mode === "offline") return { allowCodexCli, sourceAccess: { mode } };
  if (mode === "allowlist") return { allowCodexCli, sourceAccess: { mode, urls: values } };
  return { allowCodexCli, sourceAccess: { mode, allowedDomains: values.map((value) => value.toLowerCase()) } };
}

function validationError(input: {
  requested: CapabilitySet;
  maximum: CapabilitySet;
  sourceMode: SourceMode;
  values: string[];
  allowCodexCli: boolean;
}): string | undefined {
  if (!input.requested.agent || !input.maximum.agent) return ko.confirmAgentRequired;
  if (input.requested.engineering && !input.maximum.engineering) return ko.confirmEngineeringDenied;
  if (input.requested.search && !input.maximum.search) return ko.confirmSearchDenied;
  if (!input.requested.search && input.sourceMode !== "offline") return ko.confirmSearchRequired;
  if (input.sourceMode === "allowlist" && input.values.length === 0) return ko.confirmUrlRequired;
  if (input.allowCodexCli && !input.requested.engineering) return ko.confirmCodexEngineeringRequired;
  return undefined;
}

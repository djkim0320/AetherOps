import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { projectJobsQueryOptions, projectSnapshotQueryOptions } from "../../domain/queryOptions.js";
import styles from "./ProjectInspector.module.css";

const InspectorItemSchema = z
  .object({ id: z.string().optional(), title: z.string().optional(), name: z.string().optional(), summary: z.string().optional(), kind: z.string().optional() })
  .passthrough();

interface ProjectInspectorProps {
  projectId: string;
  selected: string;
  selectedItemId?: string;
  onSelect: (value: string) => void;
  onSelectItem: (itemId: string) => void;
}

export function ProjectInspector({ projectId, selected, selectedItemId, onSelect, onSelectItem }: ProjectInspectorProps): ReactElement {
  const snapshot = useQuery(projectSnapshotQueryOptions(projectId));
  const jobs = useQuery(projectJobsQueryOptions(projectId));
  const evidence = parseItems(snapshot.data?.data.evidence);
  const artifacts = parseItems(snapshot.data?.data.artifacts);
  return (
    <aside className={styles.inspector} data-ui="project-inspector" aria-label="Project inspector">
      <Tabs value={selected} onValueChange={onSelect} className={styles.tabs}>
        <TabsList aria-label="Inspector view">
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>
        <ScrollArea className={styles.body}>
          <TabsContent value="run">
            <h2>Run history</h2>
            {jobs.isError ? <p role="alert">Run history unavailable.</p> : null}
            {jobs.data?.jobs.map((job) => (
              <article className={styles.card} key={job.id}>
                <div>
                  <strong>{job.kind}</strong>
                  <Badge>{job.status}</Badge>
                </div>
                <p>{job.currentStep ?? "No active step"}</p>
              </article>
            ))}
          </TabsContent>
          <TabsContent value="evidence">
            <h2>Evidence</h2>
            <ItemList items={evidence} empty="No committed evidence." selectedItemId={selectedItemId} onSelectItem={onSelectItem} kind="evidence" />
          </TabsContent>
          <TabsContent value="artifacts">
            <h2>Artifacts</h2>
            <ItemList items={artifacts} empty="No committed artifacts." selectedItemId={selectedItemId} onSelectItem={onSelectItem} kind="artifact" />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}
function parseItems(value: unknown): z.infer<typeof InspectorItemSchema>[] {
  const parsed = z.array(InspectorItemSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
interface ItemListProps {
  items: z.infer<typeof InspectorItemSchema>[];
  empty: string;
  selectedItemId?: string;
  onSelectItem: (itemId: string) => void;
  kind: "evidence" | "artifact";
}

function ItemList({ items, empty, selectedItemId, onSelectItem, kind }: ItemListProps): ReactElement {
  const selectedItem = items.find((item) => item.id === selectedItemId);
  return (
    <div>
      {selectedItem ? (
        <section className={styles.detail} aria-label={`Selected ${kind}`}>
          <small>Selected {kind}</small>
          <h3>{itemLabel(selectedItem)}</h3>
          {selectedItem.summary ? <p>{selectedItem.summary}</p> : null}
        </section>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        items.map((item, index) =>
          item.id ? (
            <button
              type="button"
              className={styles.itemButton}
              data-selected={item.id === selectedItemId}
              aria-pressed={item.id === selectedItemId}
              key={item.id}
              onClick={() => onSelectItem(item.id!)}
            >
              <strong>{itemLabel(item)}</strong>
              {item.summary ? <span>{item.summary}</span> : null}
            </button>
          ) : (
            <article className={styles.card} key={index}>
              <strong>{itemLabel(item)}</strong>
              {item.summary ? <p>{item.summary}</p> : null}
            </article>
          )
        )
      )}
    </div>
  );
}

function itemLabel(item: z.infer<typeof InspectorItemSchema>): string {
  return item.title ?? item.name ?? item.kind ?? "Item";
}

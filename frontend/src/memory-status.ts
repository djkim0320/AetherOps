export type EmbeddingIndexStatus = {
  id: string;
  model: string;
  dimensions: number;
  state: string;
  error?: string;
};

export type ProjectMemoryStatus = {
  project_id: string;
  active_index_id?: string;
  shadow_index_id?: string;
  memory_revision: number;
  state: "empty" | "ready" | "reindexing" | "failed";
  error?: string;
  updated_at: string;
  active_index?: EmbeddingIndexStatus;
  shadow_index?: EmbeddingIndexStatus;
};

export function memoryStateLabel(status: ProjectMemoryStatus | null): string {
  if (!status) return "상태 확인 중";
  switch (status.state) {
    case "empty": return "비어 있음";
    case "ready": return "사용 가능";
    case "reindexing": return "재색인 중";
    case "failed": return "재색인 실패";
  }
}

export function canReindexMemory(status: ProjectMemoryStatus | null): boolean {
  return Boolean(status?.active_index_id) && status?.state !== "reindexing";
}

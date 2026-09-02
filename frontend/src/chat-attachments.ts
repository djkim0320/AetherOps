export const MAX_CHAT_ATTACHMENTS = 4;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml",
  "js", "jsx", "ts", "tsx", "css", "html", "py", "go", "rs", "java", "c", "h",
  "cpp", "hpp", "cs", "sql", "sh", "ps1"
]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx"]);

export type ChatAttachmentDraft = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  data: string;
  kind: "text" | "image" | "document";
};

export function attachmentAccept(): string {
  return ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.css,.html,.py,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.sql,.sh,.ps1,.pdf,.docx,.xlsx,.pptx,image/png,image/jpeg,image/gif,image/webp";
}

export async function prepareChatAttachments(
  files: Iterable<File>,
  existing: ChatAttachmentDraft[]
): Promise<ChatAttachmentDraft[]> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`첨부 파일은 한 번에 ${MAX_CHAT_ATTACHMENTS}개까지 추가할 수 있습니다.`);
  }
  const next = [...existing];
  let total = existing.reduce((sum, item) => sum + item.size, 0);
  for (const file of selected) {
    if (file.size <= 0) throw new Error(`${file.name}: 빈 파일은 첨부할 수 없습니다.`);
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error(`${file.name}: 파일당 최대 크기는 10MB입니다.`);
    total += file.size;
    if (total > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) throw new Error("첨부 파일 전체 크기는 20MB까지입니다.");
    const mediaType = file.type.toLowerCase().split(";", 1)[0];
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind = IMAGE_TYPES.has(mediaType) ? "image" : TEXT_EXTENSIONS.has(extension) ? "text" : DOCUMENT_EXTENSIONS.has(extension) ? "document" : null;
    if (!kind) {
      throw new Error(`${file.name}: 텍스트·코드·PDF·DOCX·XLSX·PPTX 또는 PNG/JPEG/GIF/WebP만 첨부할 수 있습니다.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === "text") {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    next.push({
      id: crypto.randomUUID(),
      name: file.name,
      mediaType,
      size: file.size,
      data: bytesToBase64(bytes),
      kind
    });
  }
  return next;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function formatAttachmentSize(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function textExcerpt(value: unknown, limit: number): string | undefined {
  const text = cleanString(value);
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function boundedObject(value: unknown, maxKeys: number, maxTextLength: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return textExcerpt(value, maxTextLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, maxKeys).map((item) => boundedObject(item, maxKeys, maxTextLength));
  if (typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    output[key] = /stdout|stderr|rawText|prompt/i.test(key)
      ? textExcerpt(cleanString(item), Math.min(maxTextLength, 500))
      : boundedObject(item, maxKeys, maxTextLength);
    count += 1;
  }
  return output;
}

export function collectIds(items: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const item of items) ids.push(item.id);
  return ids;
}

export function collectStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === "string") strings.push(item);
  }
  return strings;
}

export function collectLimitedStrings(values: string[], limit: number): string[] {
  const output: string[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

export function parseJsonObject(content: unknown): Record<string, unknown> | undefined {
  const text = cleanString(content);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

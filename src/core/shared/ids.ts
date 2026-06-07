export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createStableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

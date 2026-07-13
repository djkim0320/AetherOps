export function assertDurablePayload(value: unknown): void {
  if (value === undefined) return;
  visit(value, new Set<object>(), "$payload");
}

function visit(value: unknown, ancestors: Set<object>, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") throw new Error(`Durable payload contains a non-JSON value at ${path}.`);
  if (ancestors.has(value)) throw new Error(`Durable payload contains a cycle at ${path}.`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`Durable payload contains a non-plain object at ${path}.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, ancestors, `${path}[${index}]`));
  } else {
    for (const [key, item] of Object.entries(value)) visit(item, ancestors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

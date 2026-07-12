type JsonSchema = Record<string, unknown>;

export function normalizeCodexOutputSchema(schema: JsonSchema): JsonSchema {
  return normalizeNode(schema) as JsonSchema;
}

export function normalizeCodexOutputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCodexOutputValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, normalizeCodexOutputValue(entry)])
  );
}

function normalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNode);
  if (!value || typeof value !== "object") return value;
  const source = value as JsonSchema;
  if ("propertyNames" in source) throw new Error("Codex output schemas cannot contain unrestricted record keys.");
  const normalized = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => key !== "format" && key !== "default")
      .map(([key, entry]) => [key, key === "properties" || key === "$defs" ? normalizeSchemaMap(entry) : normalizeNode(entry)])
  ) as JsonSchema;
  const properties = normalized.properties;
  if (normalized.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties)) return normalized;
  if (normalized.additionalProperties !== undefined && normalized.additionalProperties !== false) {
    throw new Error("Codex output schema objects must set additionalProperties=false.");
  }
  const propertySchemas = properties as Record<string, unknown>;
  const originallyRequired = new Set(Array.isArray(source.required) ? source.required.filter((item): item is string => typeof item === "string") : []);
  normalized.properties = Object.fromEntries(
    Object.entries(propertySchemas).map(([key, entry]) => [key, originallyRequired.has(key) ? entry : nullable(entry)])
  );
  normalized.required = Object.keys(propertySchemas);
  normalized.additionalProperties = false;
  return normalized;
}

function normalizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalizeNode(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeNode(entry)]));
}

function nullable(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { anyOf: [schema, { type: "null" }] };
  const value = schema as JsonSchema;
  if (Array.isArray(value.anyOf) && value.anyOf.some((entry) => entry && typeof entry === "object" && (entry as JsonSchema).type === "null")) return value;
  if (Array.isArray(value.type) && value.type.includes("null")) return value;
  return { anyOf: [value, { type: "null" }] };
}

export type SparqlTermView = {
  termType: string;
  value: string;
  datatype?: string;
  language?: string;
};

export type SparqlTableView = {
  queryForm: string;
  complete: boolean;
  variables: string[];
  rows: Array<Record<string, SparqlTermView>>;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function term(value: unknown): SparqlTermView | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { termType: "Literal", value: String(value) };
  }
  const item = record(value);
  if (!item || !("value" in item)) return null;
  const lexical = item.value;
  if (typeof lexical !== "string" && typeof lexical !== "number" && typeof lexical !== "boolean") {
    return null;
  }
  const termType = item.term_type ?? item.type ?? "Literal";
  const datatype = item.datatype;
  const language = item.language ?? item["xml:lang"];
  return {
    termType: typeof termType === "string" ? termType : "Literal",
    value: String(lexical),
    ...(typeof datatype === "string" && datatype ? { datatype } : {}),
    ...(typeof language === "string" && language ? { language } : {})
  };
}

function rowsFrom(
  variables: string[],
  source: unknown
): Array<Record<string, SparqlTermView>> | null {
  if (!Array.isArray(source)) return null;
  const rows: Array<Record<string, SparqlTermView>> = [];
  for (const rawRow of source) {
    const item = record(rawRow);
    if (!item) return null;
    const row: Record<string, SparqlTermView> = {};
    for (const variable of variables) {
      const normalized = term(item[variable]);
      if (normalized) row[variable] = normalized;
    }
    rows.push(row);
  }
  return rows;
}

export function normalizeSparqlTableResult(value: unknown): SparqlTableView | null {
  const top = record(value);
  if (!top) return null;

  const result = record(top.result);
  if (result && String(result.type ?? "").toLowerCase() === "select") {
    const variables = Array.isArray(result.variables)
      ? result.variables.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const rows = rowsFrom(variables, result.rows);
    if (!rows) return null;
    return {
      queryForm: typeof top.query_form === "string" ? top.query_form : "SELECT",
      complete: top.complete !== false,
      variables,
      rows
    };
  }

  const head = record(top.head);
  const results = record(top.results);
  if (head && results && Array.isArray(head.vars)) {
    const variables = head.vars.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
    const rows = rowsFrom(variables, results.bindings);
    if (!rows) return null;
    return { queryForm: "SELECT", complete: true, variables, rows };
  }
  return null;
}

export function compactSparqlTerm(item: SparqlTermView): string {
  if (item.termType.toLowerCase() === "literal") return item.value;
  const known = new Map<string, string>([
    ["http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "rdf:type"],
    ["http://www.w3.org/2000/01/rdf-schema#label", "rdfs:label"],
    ["http://www.w3.org/2000/01/rdf-schema#subClassOf", "rdfs:subClassOf"],
    ["http://www.w3.org/2000/01/rdf-schema#subPropertyOf", "rdfs:subPropertyOf"]
  ]);
  const exact = known.get(item.value);
  if (exact) return exact;
  if (item.value.startsWith("urn:aetherops:core:")) {
    return `ao:${item.value.slice("urn:aetherops:core:".length)}`;
  }
  if (item.value.startsWith("urn:aetherops:project:")) {
    const tail = item.value.slice(item.value.lastIndexOf(":") + 1);
    return tail || item.value;
  }
  return item.value;
}

export function describeSparqlTerm(item: SparqlTermView): string {
  const suffix = item.language
    ? `@${item.language}`
    : item.datatype
      ? `^^${item.datatype}`
      : "";
  return `${item.value}${suffix}`;
}

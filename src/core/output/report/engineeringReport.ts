import type { ResearchSnapshot } from "../../shared/types.js";

export interface EngineeringPolarReport {
  airfoil: string;
  runtime: string;
  runtimeVersion?: string;
  runtimeLicense?: string;
  sourceUrl?: string;
  coordinateFormat?: string;
  reynolds?: number;
  mach?: number;
  alphaStart?: number;
  alphaEnd?: number;
  alphaStep?: number;
  rowCount: number;
  convergence?: Record<string, unknown>;
  rows: Array<{
    alpha: number;
    cl: number;
    cd: number;
    ld: number;
    cm?: number;
    cdp?: number;
    topXtr?: number;
  }>;
}

export function collectEngineeringPolars(snapshot: ResearchSnapshot): EngineeringPolarReport[] {
  const polars: EngineeringPolarReport[] = [];
  for (const toolRun of snapshot.toolRuns) {
    if (toolRun.toolName !== "EngineeringProgramTool" || toolRun.status !== "completed") continue;
    const output = toolRun.output && typeof toolRun.output === "object" ? (toolRun.output as Record<string, unknown>) : undefined;
    const outputs = Array.isArray(output?.outputs) ? output.outputs : [];
    for (const item of outputs) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      if (!record) continue;
      const kind = typeof record?.kind === "string" ? record.kind : "";
      if (!kind.includes("polar")) continue;
      const summary = record.summary && typeof record.summary === "object" ? (record.summary as Record<string, unknown>) : undefined;
      const polar = summary ? engineeringPolarFromSummary(summary) : undefined;
      if (polar) polars.push(polar);
    }
  }
  return polars;
}

export function engineeringPolarFromSummary(summary: Record<string, unknown>): EngineeringPolarReport | undefined {
  const rawRows = Array.isArray(summary.rows) ? summary.rows : [];
  const rows: EngineeringPolarReport["rows"] = [];
  for (const item of rawRows) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const alpha = numberValue(row?.alpha);
    const cl = numberValue(row?.cl);
    const cd = numberValue(row?.cd);
    if (alpha === undefined || cl === undefined || cd === undefined || cd === 0) continue;
    rows.push({
      alpha,
      cl,
      cd,
      ld: cl / cd,
      cm: numberValue(row?.cm),
      cdp: numberValue(row?.cdp),
      topXtr: numberValue(row?.topXtr)
    });
  }
  if (!rows.length) return undefined;
  return {
    airfoil: stringValue(summary.airfoil) || "airfoil",
    runtime: stringValue(summary.runtime) || "engineering-runtime",
    runtimeVersion: stringValue(summary.runtimeVersion),
    runtimeLicense: stringValue(summary.runtimeLicense),
    sourceUrl: stringValue(summary.sourceUrl),
    coordinateFormat: stringValue(summary.coordinateFormat),
    reynolds: numberValue(summary.reynolds),
    mach: numberValue(summary.mach),
    alphaStart: numberValue(summary.alphaStart),
    alphaEnd: numberValue(summary.alphaEnd),
    alphaStep: numberValue(summary.alphaStep),
    rowCount: numberValue(summary.rowCount) ?? rows.length,
    convergence: summary.convergence && typeof summary.convergence === "object" ? (summary.convergence as Record<string, unknown>) : undefined,
    rows
  };
}

export function formatEngineeringPolarSection(polars: EngineeringPolarReport[]): string {
  const lines: string[] = [];
  for (const polar of polars) {
    lines.push(
      `## ${polar.airfoil} (${polar.runtime}${polar.runtimeVersion ? ` ${polar.runtimeVersion}` : ""})`,
      `- 출처: ${polar.sourceUrl ?? "기록 없음"}`,
      `- 해석 조건: Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}, alpha=${polar.alphaStart ?? polar.rows[0]?.alpha}..${polar.alphaEnd ?? polar.rows.at(-1)?.alpha}, step=${polar.alphaStep ?? "n/a"}`,
      `- 데이터 행: ${polar.rowCount}; 좌표 형식=${polar.coordinateFormat ?? "unknown"}; 라이선스=${polar.runtimeLicense ?? "unknown"}`,
      `- 수렴 정보: ${polar.convergence ? JSON.stringify(polar.convergence) : "기록 없음"}`,
      "",
      "|alpha|CL|CD|L/D|CM|CDp|topXtr|",
      "|---:|---:|---:|---:|---:|---:|---:|"
    );
    for (const row of polar.rows) {
      lines.push(
        `|${formatNumber(row.alpha, 2)}|${formatNumber(row.cl, 4)}|${formatNumber(row.cd, 5)}|${formatNumber(row.ld, 2)}|${formatOptionalNumber(row.cm, 4)}|${formatOptionalNumber(row.cdp, 5)}|${formatOptionalNumber(row.topXtr, 4)}|`
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function engineeringQuantitativeLines(polars: EngineeringPolarReport[]): string[] {
  const lines: string[] = [];
  for (const polar of polars) {
    const bestLd = maxBy(polar.rows, (row) => row.ld);
    const minCd = minBy(polar.rows, (row) => row.cd);
    const first = polar.rows[0];
    const last = polar.rows.at(-1);
    lines.push(`공력 polar: ${polar.airfoil}, ${polar.rowCount}개 행, 런타임=${polar.runtime}, Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}`);
    if (first && last)
      lines.push(
        `CL 변화: alpha=${formatNumber(first.alpha, 2)}에서 ${formatNumber(first.cl, 4)}, alpha=${formatNumber(last.alpha, 2)}에서 ${formatNumber(last.cl, 4)}.`
      );
    if (minCd) lines.push(`계산 구간의 최소 CD: alpha=${formatNumber(minCd.alpha, 2)}에서 ${formatNumber(minCd.cd, 5)}.`);
    if (bestLd) lines.push(`계산 구간의 최대 L/D: alpha=${formatNumber(bestLd.alpha, 2)}에서 ${formatNumber(bestLd.ld, 2)}.`);
  }
  return lines;
}

export function engineeringFinalAnswer(polars: EngineeringPolarReport[]): string | undefined {
  const polar = polars[0];
  if (!polar) return undefined;
  const first = polar.rows[0];
  const last = polar.rows.at(-1);
  const bestLd = maxBy(polar.rows, (row) => row.ld);
  const minCd = minBy(polar.rows, (row) => row.cd);
  return [
    `${polar.airfoil} 공력 해석은 ${polar.runtime}로 실제 실행되었고, ${polar.rowCount}개의 alpha 행이 저장되었습니다.`,
    `조건은 Re=${polar.reynolds ?? "n/a"}, Mach=${polar.mach ?? "n/a"}, alpha ${polar.alphaStart ?? first?.alpha}..${polar.alphaEnd ?? last?.alpha}, step=${polar.alphaStep ?? "n/a"}입니다.`,
    first && last
      ? `CL은 alpha ${formatNumber(first.alpha, 2)}에서 ${formatNumber(first.cl, 4)}, alpha ${formatNumber(last.alpha, 2)}에서 ${formatNumber(last.cl, 4)}로 증가했습니다.`
      : "",
    minCd ? `계산 구간의 최소 CD는 alpha ${formatNumber(minCd.alpha, 2)}에서 ${formatNumber(minCd.cd, 5)}입니다.` : "",
    bestLd ? `최대 L/D는 alpha ${formatNumber(bestLd.alpha, 2)}에서 ${formatNumber(bestLd.ld, 2)}입니다.` : "",
    "해석은 WebXFOIL/XFOIL 기반 2D airfoil polar이므로 고받음각 박리와 실제 풍동 stall 판단에는 한계가 있습니다."
  ]
    .filter(Boolean)
    .join(" ");
}

export function filterQualitativeResults(values: string[], polars: EngineeringPolarReport[]): string[] {
  if (!polars.length) return values;
  return values.filter(
    (value) =>
      !/polar\s*(표|table|rows?)?.*(없|제공되지|not provided|not included)|원\s*polar\s*표|AoA.*(없|제공되지|not provided)|CL.*CD.*L\/D.*(없|제공되지|not provided|not included)/i.test(
        value
      )
  );
}

export function maxBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

export function minBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value < bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

export function formatOptionalNumber(value: number | undefined, digits: number): string {
  return value === undefined ? "" : formatNumber(value, digits);
}

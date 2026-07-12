import type { EngineeringProgramRequest, EngineeringProgramTarget, ResearchProject } from "../shared/types.js";

export type ExplicitEngineeringTarget = Exclude<EngineeringProgramTarget, "all" | "modeling">;

const TARGET_PATTERNS: ReadonlyArray<readonly [ExplicitEngineeringTarget, RegExp]> = [
  ["xfoil-wasm", /\b(?:webxfoil|xfoil[- ]?wasm)\b/i],
  ["su2", /\bsu2(?:_cfd)?\b/i],
  ["openvsp", /\bopenvsp\b/i],
  ["xflr5", /\bxflr5\b/i],
  ["xfoil", /\bxfoil\b/i]
];
const EXECUTION_OR_PIN_PATTERN =
  /\b(?:run|execute|compute|calculate|solve|simulate|required|mandatory|must|pinned|explicit(?:ly)?)\b|실행|계산|해석|필수|지정/i;

export function detectExplicitEngineeringTarget(project: Pick<ResearchProject, "goal" | "topic" | "scope">): ExplicitEngineeringTarget | undefined {
  for (const text of [project.goal, project.topic, project.scope]) {
    if (!EXECUTION_OR_PIN_PATTERN.test(text)) continue;
    const matches = TARGET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([target]) => target);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

export function requestMatchesExplicitTarget(request: EngineeringProgramRequest, target: ExplicitEngineeringTarget): boolean {
  if (request.target !== target) return false;
  if (request.kind !== requiredKindForTarget(target)) return false;
  return request.cfdRunSpec === undefined || request.cfdRunSpec.target === target;
}

function requiredKindForTarget(target: ExplicitEngineeringTarget): EngineeringProgramRequest["kind"] {
  if (target === "xfoil-wasm") return "xfoil-wasm-polar";
  if (target === "xfoil") return "xfoil-polar";
  if (target === "su2") return "su2-case-run";
  if (target === "openvsp") return "openvsp-analysis-run";
  return "xflr5-analysis-run";
}

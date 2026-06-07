import { createId, nowIso } from "../shared/ids.js";
import type { Hypothesis, ResearchInput, ResearchProject, ResearchQuestion } from "../shared/types.js";

export interface ResearchInputPayload {
  researchQuestion?: string;
  initialHypotheses?: string[];
  constraints?: string[];
  expectedOutputs?: string[];
}

export type ResearchBriefInput = Pick<ResearchProject, "goal" | "topic" | "scope" | "budget">;

export function buildResearchInputPayloadFromBrief(
  brief: ResearchBriefInput,
  payload: ResearchInputPayload = {}
): Required<ResearchInputPayload> {
  const combined = joinPresent("\n", brief.goal, brief.scope, brief.budget);
  const explicitConstraints = cleanArray(payload.constraints);
  const explicitOutputs = cleanArray(payload.expectedOutputs);
  const researchQuestion = clean(payload.researchQuestion) || clean(brief.goal) || clean(brief.topic);
  const explicitHypotheses = cleanArray(payload.initialHypotheses);

  return {
    researchQuestion,
    initialHypotheses: explicitHypotheses.length
      ? explicitHypotheses
      : deriveInitialHypotheses({ ...brief, combined, researchQuestion }),
    constraints: explicitConstraints.length
      ? explicitConstraints
      : extractInlineList(combined, /제약\s*[:：]\s*([\s\S]*?)(?=(?:최종\s*산출물|예상\s*산출물)\s*[:：]|$)/),
    expectedOutputs: explicitOutputs.length
      ? explicitOutputs
      : extractInlineList(combined, /(?:최종\s*산출물|예상\s*산출물)\s*[:：]\s*([\s\S]*?)$/)
  };
}

export function createResearchInput(project: ResearchProject, payload: ResearchInputPayload): {
  input: ResearchInput;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
} {
  const resolvedPayload = buildResearchInputPayloadFromBrief(project, payload);
  const researchQuestion = clean(resolvedPayload.researchQuestion);
  const initialHypotheses = cleanArray(resolvedPayload.initialHypotheses);
  if (!researchQuestion) {
    throw new Error("연구 질문을 입력해야 합니다.");
  }
  if (!initialHypotheses.length) {
    throw new Error("초기 가설을 1개 이상 입력해야 합니다.");
  }

  const createdAt = nowIso();
  const input: ResearchInput = {
    id: createId("input"),
    projectId: project.id,
    researchQuestion,
    initialHypotheses,
    constraints: cleanArray(resolvedPayload.constraints),
    expectedOutputs: cleanArray(resolvedPayload.expectedOutputs),
    createdAt
  };
  const question: ResearchQuestion = {
    id: createId("question"),
    projectId: project.id,
    researchInputId: input.id,
    text: researchQuestion,
    status: "open",
    createdAt
  };
  const hypotheses: Hypothesis[] = [];
  for (const statement of initialHypotheses) {
    hypotheses.push({
      id: createId("hypothesis"),
      projectId: project.id,
      researchInputId: input.id,
      questionId: question.id,
      statement,
      status: "untested",
      confidence: 0.2,
      createdAt
    });
  }

  return { input, questions: [question], hypotheses };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned: string[] = [];
  for (const item of value) {
    const text = clean(item);
    if (text) cleaned.push(text);
  }
  return cleaned;
}

function deriveInitialHypotheses(input: ResearchBriefInput & { combined: string; researchQuestion: string }): string[] {
  const explicit = extractExplicitSections(
    input.combined,
    /가설\s*[A-Za-z0-9가-힣-]*\s*[:：]\s*/g,
    /(?:제약|범위|최종\s*산출물|예상\s*산출물|조건)\s*[:：]/
  );
  if (explicit.length) return explicit;

  const whetherClause = extractWhetherClause(input.researchQuestion);
  if (whetherClause) return [ensureSentence(whetherClause)];

  const compareText = clean(input.topic) || clean(input.researchQuestion);
  if (/\b(compare|versus|vs\.?)\b|비교/i.test(compareText)) {
    return [ensureSentence(`The compared approaches have traceable evidence differences for ${compareText}`)];
  }

  const brief = clean(input.researchQuestion) || clean(input.topic) || clean(input.scope);
  return brief ? [ensureSentence(`Traceable evidence can evaluate the project brief: ${brief}`)] : [];
}

function extractWhetherClause(text: string): string {
  const match = text.match(/\b(?:evaluate|assess|test|determine|investigate|verify)\s+whether\s+(.+?)(?:[.?!]|$)/i);
  return clean(match?.[1]);
}

function extractExplicitSections(text: string, marker: RegExp, stop: RegExp): string[] {
  const matches = [...text.matchAll(marker)];
  if (!matches.length) {
    return [];
  }
  const values: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const start = current.index === undefined ? 0 : current.index + current[0].length;
    const after = text.slice(start, next?.index);
    const stopMatch = after.match(stop);
    const candidate = cleanHypothesisText(stopMatch?.index === undefined ? after : after.slice(0, stopMatch.index));
    if (candidate) values.push(candidate);
  }
  return firstItems(dedupeStrings(values), 6);
}

function extractInlineList(text: string, pattern: RegExp): string[] {
  const match = text.match(pattern);
  if (!match?.[1]) {
    return [];
  }
  const values: string[] = [];
  for (const item of match[1].split(/\n|;|,|ㆍ|·/)) {
    const cleaned = item.replace(/^[-*\d.)\s]+/, "").trim();
    if (cleaned) values.push(cleaned);
  }
  return firstItems(dedupeStrings(values), 8);
}

function cleanHypothesisText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^(?:[-*\d.)]\s*)+/, "")
    .trim()
    .replace(/\s+(?=(?:가설|제약|최종\s*산출물)\s*[:：]).*$/s, "")
    .trim();
}

function ensureSentence(value: string): string {
  const cleaned = clean(value);
  if (!cleaned) return "";
  const sentence = `${cleaned[0].toLocaleUpperCase()}${cleaned.slice(1)}`;
  return /[.!?。]$/.test(sentence) ? sentence : `${sentence}.`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function firstItems<T>(values: T[], limit: number): T[] {
  const output: T[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

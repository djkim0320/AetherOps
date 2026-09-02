import type { ChatMode } from "./types";

export type ComposerPromptChip =
  | { label: string; kind: "prompt"; value: string }
  | { label: string; kind: "mode"; value: "plan" };

export const COMPOSER_PROMPT_CHIPS: ComposerPromptChip[] = [
  { label: "프로젝트 분석", kind: "prompt", value: "프로젝트 아키텍처와 주요 의존성을 분석해줘" },
  { label: "성능 최적화", kind: "prompt", value: "시스템 병목 지점과 성능 최적화 방안을 검토해줘" },
  { label: "단위 테스트", kind: "prompt", value: "핵심 모듈에 대한 포괄적인 단위 테스트 계획을 세워줘" },
  { label: "계획 수립", kind: "mode", value: "plan" }
];

export function shouldBootstrapPlanCycle(mode: ChatMode, hasPlanCycle: boolean): boolean {
  return mode === "plan" && !hasPlanCycle;
}

export function shouldStartPlanCycleFromSlashArgument(argument: string): boolean {
  return argument.trim().length > 0;
}

export function composerModePresentation(mode: ChatMode) {
  if (mode === "plan") {
    return {
      active: true,
      glyph: "P",
      label: "계획 모드 · 선택됨",
      placeholder: "계획할 작업과 검증 범위를 설명하세요…"
    } as const;
  }
  return {
    active: false,
    glyph: "C",
    label: "대화",
    placeholder: ""
  } as const;
}

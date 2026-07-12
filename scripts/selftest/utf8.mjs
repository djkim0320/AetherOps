import { existsSync, readFileSync } from "node:fs";

import { KOREAN_UTF8_SENTINELS, MOJIBAKE_MARKER } from "./utf8-constants.mjs";

export function auditUtf8Files(files) {
  const failures = [];
  const bomFiles = [];
  const audits = new Map();
  for (const file of files) {
    const audit = auditUtf8File(file);
    audits.set(file, audit);
    if (!audit.fatalOk) failures.push({ file: audit.relativePath, error: audit.error });
    if (audit.hasBom) bomFiles.push(audit.relativePath);
  }
  return { fileCount: files.length, fatalOk: failures.length === 0, failures, bomFiles, audits };
}

export function auditUtf8File(file) {
  if (!existsSync(file)) {
    return { text: "", fatalOk: false, hasBom: false, firstBytes: "", relativePath: file, error: "File does not exist." };
  }
  const bytes = readFileSync(file);
  const firstBytes = bytes.subarray(0, 4).toString("hex");
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, fatalOk: !text.includes("\uFFFD"), hasBom, firstBytes, relativePath: file };
  } catch (error) {
    return {
      text: "",
      fatalOk: false,
      hasBom,
      firstBytes,
      relativePath: file,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function scanAuditUtf8(files, audits = new Map()) {
  const result = {
    hasQuestionQuestion: false,
    hasReplacement: false,
    hasMojibake: false,
    hasKoreanRequirement: false,
    koreanSentinels: Object.fromEntries(KOREAN_UTF8_SENTINELS.map((item) => [item, false]))
  };
  for (const file of files) {
    const audit = audits.get(file) ?? auditUtf8File(file);
    const text = audit.text;
    result.hasQuestionQuestion ||= /[?]{2,}/.test(text);
    result.hasReplacement ||= text.includes("\uFFFD");
    result.hasMojibake ||= MOJIBAKE_MARKER.test(text);
    result.hasKoreanRequirement ||= text.includes("Embedding API key 설정이 필요합니다") || text.includes("LLM 설정") || text.includes("Codex OAuth");
    for (const sentinel of KOREAN_UTF8_SENTINELS) {
      result.koreanSentinels[sentinel] ||= text.includes(sentinel);
    }
  }
  return result;
}

export function sentinelStatus(text, sentinels) {
  return Object.fromEntries(sentinels.map((sentinel) => [sentinel, text.includes(sentinel)]));
}

export { KOREAN_UTF8_SENTINELS, MOJIBAKE_MARKER } from "./utf8-constants.mjs";

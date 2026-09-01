import type { BrowserOperationalStatus, Schedule } from "./types";

export type JSONGetter = (path: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadSchedulesState(getJSON: JSONGetter): Promise<Schedule[]> {
  const payload = await getJSON("/api/v1/schedules");
  if (payload === null) return [];
  if (Array.isArray(payload)) return payload as Schedule[];
  if (isRecord(payload) && Array.isArray(payload.schedules)) {
    return payload.schedules as Schedule[];
  }
  throw new Error("연구 일정 응답 형식이 올바르지 않습니다.");
}

export async function loadBrowserOperationalStatus(
  getJSON: JSONGetter
): Promise<BrowserOperationalStatus> {
  const payload = await getJSON("/api/v1/browser");
  if (!isRecord(payload)) {
    throw new Error("브라우저 상태 응답 형식이 올바르지 않습니다.");
  }
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  const mode = payload.mode;
  if (!status || (mode !== "automatic" && mode !== "manual")) {
    throw new Error("브라우저 상태 응답에 필수 값이 없습니다.");
  }
  return payload as BrowserOperationalStatus;
}

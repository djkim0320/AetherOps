export type RunControlRef = {
	id: string;
	conversation_session_id: string;
	status: string;
	error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canDiscardRun(status: string | undefined, busy: string | null): boolean {
	return busy === null && (status === "interrupted" || status === "uncertain");
}

export function blockingRunFrom(payload: unknown): RunControlRef | null {
	if (!isRecord(payload) || !isRecord(payload.blocking_run)) return null;
	const candidate = payload.blocking_run;
	if (
		typeof candidate.id !== "string" || candidate.id.length === 0 ||
		typeof candidate.conversation_session_id !== "string" || candidate.conversation_session_id.length === 0 ||
		typeof candidate.status !== "string" || candidate.status.length === 0
	) return null;
	return candidate as RunControlRef;
}

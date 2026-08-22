export function shouldRefreshApprovals(eventKind: string | undefined): boolean {
	return typeof eventKind === "string" && eventKind.startsWith("approval.");
}

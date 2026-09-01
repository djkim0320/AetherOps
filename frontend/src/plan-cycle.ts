export type PlanningObjectiveMessage = {
	role: "user" | "assistant" | "system";
	mode: "chat" | "plan";
	text: string;
};

// Snapshot only user requirements supplied after the previous planning cycle.
// Choice answers from an older cycle must never become the next objective.
export function planningObjective(messages: PlanningObjectiveMessage[], explicit = ""): string {
	const supplied = explicit.trim();
	if (supplied) return supplied;
	let previousPlan = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].mode === "plan") {
			previousPlan = index;
			break;
		}
	}
	const snapshot = messages.slice(previousPlan + 1)
		.filter((message) => message.role === "user" && message.mode === "chat")
		.map((message) => message.text.trim())
		.filter(Boolean)
		.join("\n\n");
	return snapshot || "계획 시작 시점에 아직 구체적인 연구 목표가 제시되지 않았습니다. 계획 인터뷰에서 목표를 먼저 확정합니다.";
}

export function parseSlashCommand(input: string): { command: string; argument: string } | null {
	const trimmed = input.trim();
	const match = /^(\/[^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	return { command: match[1].toLowerCase(), argument: (match[2] ?? "").trim() };
}

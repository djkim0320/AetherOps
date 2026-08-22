const artifactIDPattern = /^art_[a-f0-9]{32}$/;

export function artifactContentPath(artifactID: string): string {
	const canonical = artifactID.trim();
	if (!artifactIDPattern.test(canonical)) {
		throw new Error("Invalid AetherOps artifact identifier");
	}
	return `/api/v1/artifacts/${encodeURIComponent(canonical)}`;
}

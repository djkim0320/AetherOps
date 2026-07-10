const SECRET_PATTERN = /(access_token|refresh_token|id_token)["'=:\s]+[A-Za-z0-9._-]+/gi;

export function sanitizeOpenCodeCommandOutput(text: string): string {
  return text.replace(SECRET_PATTERN, "$1=<redacted>");
}

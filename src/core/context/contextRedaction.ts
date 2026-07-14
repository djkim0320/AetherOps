export interface RedactedContextText {
  text: string;
  replacements: number;
  categories: string[];
}

interface RedactionRule {
  category: string;
  pattern: RegExp;
}

const RULES: RedactionRule[] = [
  { category: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { category: "authorization", pattern: /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{4,}/gi },
  { category: "credential_token", pattern: /\b(?:sk-[a-z0-9_-]{8,}|gh[oprsu]_[a-z0-9_]{12,}|glpat-[a-z0-9_-]{10,}|xox[baprs]-[a-z0-9-]{10,})\b/gi },
  { category: "jwt", pattern: /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi },
  {
    category: "assigned_secret",
    pattern:
      /\b(?:(?:[a-z][a-z0-9_]{1,80}_)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|oauth|client[-_]?secret)|aws_(?:access_key_id|secret_access_key|session_token)|database_url|connection_string)\s*[:=]\s*["']?[^\s,;"']{3,}["']?/gi
  },
  { category: "url_secret", pattern: /([?&](?:api[-_]?key|token|secret|signature)=)[^&#\s]+/gi },
  { category: "local_path", pattern: /(?:[a-zA-Z]:[\\/](?:[^\s"'<>|]+[\\/]?)+|\/(?:Users|home|tmp|var\/tmp)\/[^\s"']+)/g }
];

export function redactContextText(value: string): RedactedContextText {
  let text = value;
  let replacements = 0;
  const categories = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, () => {
      replacements += 1;
      categories.add(rule.category);
      return `[REDACTED:${rule.category}]`;
    });
  }
  return { text, replacements, categories: [...categories].sort() };
}

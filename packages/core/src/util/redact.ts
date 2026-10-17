/**
 * Secret redaction. Analysed material is untrusted and may contain
 * credentials; we never surface their values — only that something
 * secret-shaped exists and where.
 */

interface SecretRule {
  name: string;
  re: RegExp;
}

const RULES: SecretRule[] = [
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g },
  { name: "stripe-secret", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,200}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,300}\b/g },
  { name: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,300}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  {
    name: "assignment",
    re: /\b([A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'`]{6,})["']?/gi,
  },
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi },
];

export function redactSecrets(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: string[]) => {
      found.push(rule.name);
      if (rule.name === "assignment") return `${m[1]}=[REDACTED]`;
      if (rule.name === "url-credentials") return `${m[1]}[REDACTED]@`;
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text: out, found };
}

export function findSecretLikeValues(text: string): string[] {
  return [...new Set(redactSecrets(text).found)];
}

/**
 * Extract environment variable NAMES referenced by code or .env files.
 * Values are never returned.
 */
export function envVarNames(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
    /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
    /os\.environ(?:\.get)?\(?\[?["']([A-Z_][A-Z0-9_]*)["']/g,
    /os\.getenv\(["']([A-Z_][A-Z0-9_]*)["']/g,
    /env::var\("([A-Z_][A-Z0-9_]*)"\)/g,
    /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g,
    /ENV\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) names.add(m[1]);
  return [...names].sort();
}

/** Names declared in a dotenv-style file (KEY=value). Values are never returned. */
export function dotenvNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) if (m[1]) names.add(m[1]);
  return [...names].sort();
}
